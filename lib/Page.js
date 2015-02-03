var common = require('./common.js');
var events = require('events');
var url = require('url');
var util = require('util');

var Page = function (id, url, includeBodies, Network) {
    this.id = id;
    this.url = url;
    this.includeBodies = includeBodies;
    this.Network = Network;
    this.entries = {};
    this.startTimestamp = undefined;
    this.domTime = undefined;
    this.endTime = undefined;
    this.originalRequestId = undefined;
    this.originalRequestStatus = undefined; // true ok; false fail
    this.activeRequests = 1;
};

util.inherits(Page, events.EventEmitter);

Page.prototype.start = function () {
    this.startTimestamp = new Date();
};

Page.prototype.domLoaded = function () {
    this.domLoadedTime = new Date() - this.startTimestamp;
};

Page.prototype.addRequest = function () {
    this.activeRequests++;
};

Page.prototype.removeRequest = function () {
    if(--this.activeRequests === 0) {
        this.emit('end');
    }
};

Page.prototype.end = function () {
    this.endTime = new Date() - this.startTimestamp;
    this.removeRequest();
};

Page.prototype.isDone = function () {
    // a page is done if both Page.domContentEventFired and Page.loadEventFired
    // events are fired and the original request got a response

    return this.domLoadedTime && this.endTime &&
        this.originalRequestId &&
        typeof this.originalRequestStatus != 'undefined' &&
	this.activeRequests == 0;
};

Page.prototype.isOk = function () {
    return this.originalRequestStatus;
};

// New typical sequence:

// * OLD
// Page.frameDetached

// * NEW(main)
// Page.frameStartedLoading
// Network.requestWillBeSent
// Network.responseReceived
// Page.frameNavigated
// Network.requestWillBeSend - Network.responseReceived
// Page.loadEventFired
// Page.frameStoppedLoading

// Loading:
// Network.requestWillBeSend - requestId, frameId, loaderId
// (Network.requestServedFromCache - requestId)
// Network.responseReceived - requestId, frameId, loaderId
// Network.dataReceived - requestId
// Network.loadingFinished - requestId


// * NEW(attached)
// Page.frameAttached - parentFrameId
// Page.frameStartedLoading
// Network.requestWillBeSent
// Network.responseReceived (params.type)
// Page.frameNavigated - parentId
// Page.frameStoppedLoading
// Network.requestWillBeSend...


// typical sequence:
//
// Network.requestWillBeSent # about to send a request
// Network.responseReceived  # headers received
// Network.dataReceived      # data chunk received
// [...]
// Network.loadingFinished   # full response received


Page.prototype.processMessage = function (message) {
    var id = message.params.requestId;
    switch (message.method) {
    case 'Network.requestWillBeSent':
        if (!this.originalRequestId &&
            sameURL(this.url, message.params.request.url)) {
            this.originalRequestId = id;
        }
        this.entries[id] = {
            'requestEvent': message.params,
            'responseEvent': undefined,
            'responseLength': 0,
            'encodedResponseLength': 0,
            'responseFinished': undefined
        };
        break;
    case 'Network.dataReceived':
        if (id in this.entries) {
            this.entries[id].responseLength += message.params.dataLength;
            this.entries[id].encodedResponseLength += message.params.encodedDataLength;
            break;
        }
        return;
    case 'Network.responseReceived':
       if (id in this.entries) {
            this.entries[id].responseEvent = message.params;
            break;
        }
        return;
    case 'Network.loadingFinished':
         if(this.includeBodies) {
            var that = this;
	    that.addRequest();
            this.Network.getResponseBody({'requestId': id }, function(error, result) {
                if(!error) {
                    that.entries[id].responseBody = result;
                }
		that.removeRequest();
            });
        }
        if (id == this.originalRequestId) {
            this.originalRequestStatus = true;
        }
        if (id in this.entries) {
            this.entries[id].responseFinished = message.params.timestamp;
            break;
        }
        return;
    case 'Network.loadingFailed':
        if (id == this.originalRequestId) {
            this.originalRequestStatus = false;
        }
        if (id in this.entries) {
            break; // just log dump
        }
        return;
    default:
        common.dump('Unhandled message: ' + message.method);
        return;
    }
    common.dump('<-- ' + '[' + id + '] ' + message.method);
};

Page.prototype.getHAR = function () {
    var har = {
        'info': {
            'startedDateTime': this.startTimestamp.toISOString(),
            'id': this.id.toString(),
            'title': this.url,
            'pageTimings': {
                'onContentLoad': this.domLoadedTime,
                'onLoad': this.endTime
            }
        },
        'entries': []
    };

    for (var requestId in this.entries) {
        var entry = this.entries[requestId];

        // skip incomplete entries
        if (!entry.responseEvent || !entry.responseFinished) continue;

        // skip entries with no timing information (it's optional)
        var timing = entry.responseEvent.response.timing;
        if (!timing) continue;

        // skip data URI scheme requests
        if (entry.requestEvent.request.url.substr(0, 5) == 'data:') continue;

        // analyze headers
        var requestHeaders = convertHeaders(entry.requestEvent.request.headers);
        var responseHeaders = convertHeaders(entry.responseEvent.response.headers);

        // add status line length
        requestHeaders.size += (entry.requestEvent.request.method.length +
                                entry.requestEvent.request.url.length +
                                12); // "HTTP/1.x" + "  " + "\r\n"

        responseHeaders.size += (entry.responseEvent.response.status.toString().length +
                                 entry.responseEvent.response.statusText.length +
                                 12); // "HTTP/1.x" + "  " + "\r\n"

        // query string
        var queryString = convertQueryString(entry.requestEvent.request.url);

        // compute timing informations: input
        var dnsTime = timeDelta(timing.dnsStart, timing.dnsEnd);
        var proxyTime = timeDelta(timing.proxyStart, timing.proxyEnd);
        var connectTime = timeDelta(timing.connectStart, timing.connectEnd);
        var sslTime = timeDelta(timing.sslStart, timing.sslEnd);
        var sendTime = timeDelta(timing.sendStart, timing.sendEnd);

        // compute timing informations: output
        var dns = proxyTime + dnsTime;
        var connect = connectTime;
        var ssl = sslTime;
        var send = sendTime;
        var wait = timing.receiveHeadersEnd - timing.sendEnd;
        var receive = Math.round(entry.responseFinished * 1000 -
                                 timing.requestTime * 1000 -
                                 timing.receiveHeadersEnd);
        var blocked = -1; // TODO
        var totalTime = dns + connect + ssl + send + wait + receive;

        // fill entry
        var harEntry = {
            'pageref': this.id.toString(),
            'startedDateTime': new Date(timing.requestTime * 1000).toISOString(),
            'time': totalTime,
            'request': {
                'method': entry.requestEvent.request.method,
                'url': entry.requestEvent.request.url,
                'httpVersion': 'HTTP/1.1', // TODO
                'cookies': [], // TODO
                'headers': requestHeaders.pairs,
                'queryString': queryString,
                'headersSize': requestHeaders.size,
                'bodySize': entry.requestEvent.request.headers['Content-Length'] || -1,
            },
            'response': {
                'status': entry.responseEvent.response.status,
                'statusText': entry.responseEvent.response.statusText,
                'httpVersion': 'HTTP/1.1', // TODO
                'cookies': [], // TODO
                'headers': responseHeaders.pairs,
                'redirectURL': '', // TODO
                'headersSize': responseHeaders.size,
                'bodySize': entry.encodedResponseLength,
                'content': {
                    'size': entry.responseLength,
                    'mimeType': entry.responseEvent.response.mimeType,
                    'compression': entry.responseLength - entry.encodedResponseLength
                }
            },
            'cache': {},
            'timings': {
                'blocked': blocked,
                'dns': timing.dnsStart == -1 ? -1 : dns, // -1 = n.a.
                'connect': timing.connectStart == -1 ? -1 : connect, // -1 = n.a.
                'send': send,
                'wait': wait,
                'receive': receive,
                'ssl': timing.sslStart == -1 ? -1 : ssl // -1 = n.a.
            }
        };

        if(entry.responseBody) {
            harEntry.response.content.text = entry.responseBody.body;
            if(entry.responseBody.base64Encoded) {
                harEntry.response.encoding = "base64";
            }
        }

        har.entries.push(harEntry);
    }

    return har;
};

function convertQueryString(fullUrl) {
    var query = url.parse(fullUrl, true).query;
    var pairs = [];
    for (var name in query) {
        var value = query[name];
        pairs.push({'name': name, 'value': value.toString()});
    }
    return pairs;
}

function convertHeaders(headers) {
    headersObject = {'pairs': [], 'size': -1};
    if (Object.keys(headers).length) {
        headersObject.size = 2; // trailing "\r\n"
        for (var name in headers) {
            var value = headers[name];
            headersObject.pairs.push({'name': name, 'value': value});
            headersObject.size += name.length + value.length + 4; // ": " + "\r\n"
        }
    }
    return headersObject;
}

function timeDelta(start, end) {
    return start != -1 && end != -1 ? (end - start) : 0;
}

function sameURL(a, b) {
    return JSON.stringify(url.parse(a)) == JSON.stringify(url.parse(b));
}

module.exports = Page;
