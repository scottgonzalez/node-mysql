// RawConnection: 
// MySQL packet I/O
// http://forge.mysql.com/wiki/MySQL_Internals_ClientServer_Protocol#The_Packet_Header
var sys = require('sys');
var events = require("events");
var pack = require('./pack');
var errors = require('./errors');
var Promise = require('./node-promise').Promise;
var Socket = require('./node-socket').Socket;
process.mixin(require('./common'));


var MAX_PACKET_LENGTH = 16777215;

var Connection = function(port, hostname) {
    events.EventEmitter.call(this);
    this.hostname = hostname;
    this.port = port;
    this.seq = 0; // packet sequence number
    this.socket = new Socket(scope(this, function(){ this.emit("connect"); }),
			     scope(this, function(){ this.emit("close"); }));
}
sys.inherits(Connection, events.EventEmitter);
exports.Connection = Connection;

// set timeout
Connection.prototype.timeout = function(timeout) {
    this.socket.timeout(timeout);
}

// open TCP socket
Connection.prototype.connect = function() {
    this.socket.connect(this.port, this.hostname);
}

// reset packet sequence
Connection.prototype.reset = function() {
    this.seq = 0;
}

// close TCP socket
Connection.prototype.close = function() {
    this.socket.close();
}
	
// Read one packet data
Connection.prototype.read = function(packet_count) {
    var promise = new Promise();
    var ret = "";
    var len = undefined;
    var packets = [];
    var read_packet = scope(this, function() {
	this.socket.read(4)
	    .addCallback(scope(this, function(header) {
		var res = pack.unpack("CvC", header);
		len = (res[1] << 8) + res[0];
		if(res[2] != this.seq) {
		    promise.emitError(new errors.ProtocolError("invalid packet: sequence number mismatch("+res[2]+" != "+this.seq+"(expected))"));
		    return;
		}
		this.seq = (res[2] + 1) % 256;
		
		this.socket.read(len)
		    .addCallback(scope(this, function(data) {
			ret = ret.concat(data);
			
			var sqlstate = "00000";
			// Error packet
			if(ret[0]=="\xff") {
			    var res = pack.unpack("Cvaa5a*", ret);
			    var f = res[0], errno = res[1], marker = res[2], sqlstate = res[3], message = res[4];
			    if(marker!="#") {
				res = pack.unpack("Cva*", ret);    // Version 4.0 Error
				f = res[0], errno = res[1], message = res[2]; 
				sqlstate = "";
			    }
			    promise.emitError(new errors.ServerError(message, errno, sqlstate));
			}
			else {
			    packets.push(ret);
			    if(typeof(packet_count)=='undefined') {
				promise.emitSuccess(ret);
			    }
			    else if(packets.length>=packet_count) {
				promise.emitSuccess(packets);
			    }
			    else {
				read_packet();
			    }
			}
		    }))
	            .addErrback(scope(this, function(error) {
			promise.emitError(new errors.ClientError("Socket connection error"));
		    }));
	    }))
	    .addErrback(scope(this, function(error) {
		promise.emitError(new errors.ClientError("Socket connection error"));
	    }));
    });
    read_packet();
    return promise;
}


// Write one packet data
Connection.prototype.write = function(data) {
    var promise = new Promise();
    
    if(typeof(data)=='undefined') {
	this.socket.write(pack.pack("CvC", 0, 0, this.seq));
	this.seq = (this.seq + 1) % 256
	promise.emitSuccess();
    }
    else {
	var buf;
	while(data) {
	    buf = data.substring(0, MAX_PACKET_LENGTH);
	    data = data.slice(MAX_PACKET_LENGTH);
	    this.socket.write(pack.pack("CvC", buf.length%256, buf.length/256, this.seq));
	    this.socket.write(buf);
	    this.seq = (this.seq + 1) % 256;
	}
	promise.emitSuccess();
    }
    
    return promise;
}

/*
node-mysql
A node.js interface for MySQL

Author: masuidrive <masui@masuidrive.jp>
License: MIT License
Copyright (c) Yuichiro MASUI

# Original:
# http://github.com/tmtm/ruby-mysql
# Copyright (C) 2009-2010 TOMITA Masahiro
# mailto:tommy@tmtm.org
# License: Ruby's
*/
