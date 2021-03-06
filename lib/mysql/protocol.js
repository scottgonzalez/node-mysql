// Protocol:
// MySQL Protocol 
var sys = require('sys');
var events = require('events');
var pack = require('./pack');
var errors = require('./errors');
var constants = require('./constants');
var packet = require('./packet');
var auth = require('./auth');
var Charset = require('./charset').Charset;
var Promise = require('./node-promise').Promise;
var Connection = require('./connection').Connection;
process.mixin(require('./common'));

var Protocol = function(host, port) {
    events.EventEmitter.call(this);
    this.state = undefined;
    this.gc_stmt_queue = [];
    this.ready_state_queue = [];
    this.charset = undefined;
    this.authinfo = undefined;
    this.server_info = undefined;
    this.server_version = undefined;
    this.thread_id = undefined;
    this.message = undefined;
    this.affected_rows = undefined;
    this.insert_id = undefined;
    this.server_status = undefined;
    this.warning_count = undefined;
    
    this.set_state('INIT');
    this.conn = new Connection(port || 3306, host || 'localhost');

    this.conn.addListener('connect', scope(this, function() {	
	this.emit('connect');
    }));
    this.conn.addListener('close', scope(this, function() {	
	this.gc_stmt_queue = [];
	this.set_state('INIT');
	this.emit('close');
    }));

    this.conn.connect();
}
sys.inherits(Protocol, events.EventEmitter);
exports.Protocol = Protocol;

// close TCP session
Protocol.prototype.close = function() {
    this.wait_ready_state(scope(this, function() {
	this.conn.close();
    }));
}

Protocol.prototype.gc_stmt = function(stmt_id) {
    this.gc_stmt_queue.push(stmt_id);
}

// authenticate process
Protocol.prototype.authenticate = function(user, passwd, db, flag, charset_str) {
    var promise = new Promise();
    if(!this.check_state('INIT', promise)) return promise;
    this.authinfo = [user, passwd, db, flag, charset_str];
    this.conn.reset();
    this.conn.read()
	.addCallback(scope(this, function(buff) {
	    var init_packet = new packet.InitialPacket(buff);
	    if(init_packet.protocol_version!=10) {
		promise.emitError(new errors.ClientError("Don't support protocol version "+init_packet.protocol_version));
		return;
	    }
	    this.server_info = init_packet.server_version;
	    var i = init_packet.server_version.split(".");
	    this.server_version = parseInt(i[0])*100+parseInt(i[1]);
	    
	    this.thread_id = init_packet.thread_id;
	    var client_flags = constants.client.LONG_PASSWORD
		| constants.client.LONG_FLAG
		| constants.client.TRANSACTIONS
		| constants.client.PROTOCOL_41
		| constants.client.SECURE_CONNECTION;
	    if(db) client_flags |= constants.client.CONNECT_WITH_DB;
	    client_flags |= flag;
	    
	    if(charset_str) {
		this.charset = Charset.by_name(charset_str);
	    }
	    else {
		this.charset = Charset.by_number(init_packet.server_charset);
	    }
	    
	    var netpw = auth.encrypt_password(passwd, init_packet.scramble_buff);
	    try {
		this.conn.write(packet.AuthenticationPacket(client_flags, 1024*1024*1024, this.charset.number, user, netpw, db));
		this.conn.read()
		    .addCallback(scope(this, function(buff){
			this.query_command("SET NAMES '"+this.charset.name+"'", true);
			this.set_state('READY');
			this.emit("authorized");
			promise.emitSuccess();
		    }))
		    .addErrback(scope(this, function(error) {
			this.emit("authorize error");
			promise.emitError(error);
		    }));
	    }
	    catch(e) {
		promise.emitError(new errors.ClientError(e.message));
	    }
	}))
	.addErrback(scope(this, function(error) {
	    this.emit("authorize error");
	    promise.emitError(error);
	}));
    return promise;
}

// send query command
Protocol.prototype.query_command = function(query, immediately) {
    var promise = new Promise();
    
    var err = scope(this, function(error) {
	this.set_state('READY');
	promise.emitError(error);
    });
    
    this.wait_ready_state(scope(this, function() {
	this.set_state('PROCESS');
	this.conn.reset();
	this.conn.write(pack.pack("CZ*", constants.com.QUERY, this.charset.convertToBytes(query)))
	    .addCallback(scope(this, function(buff) {
		this.get_result()
		    .addCallback(function(nfields) {
			promise.emitSuccess(nfields);
		    })
		    .addErrback(err);
	    }))
	    .addErrback(err);
    }), immediately);
    return promise;
}

// read result fields count
Protocol.prototype.get_result = function() {
    var promise = new Promise();
    this.conn.read()
	.addCallback(scope(this, function(buff) {
            var res_packet = packet.ResultPacket.parse(buff);
            this.affected_rows = res_packet.affected_rows;
	    this.insert_id = res_packet.insert_id;
	    this.server_status = res_packet.server_status;
	    this.warning_count = res_packet.warning_count;
	    this.message = res_packet.message;
	    
            if(res_packet.field_count>0) {  // result data exists
		this.set_state('FIELD');
		promise.emitSuccess(res_packet.field_count);
	    }
            else if(typeof(res_packet.field_count)=='undefined') {  // LOAD DATA LOCAL INFILE
		// TODO
		/*
		  filename = res_packet.message
		  File.open(filename){|f| write f}
		  conn.write(nil);  # EOF mark
		  conn.read().addCallback(..
		*/
	    }
	    else { // field_count == 0
		this.set_state('READY');
		promise.emitSuccess(undefined);
	    }
	}))
        .addErrback(scope(this, function(error) {
	    promise.emitError(error);
	}));
    return promise;
}

// Set option command
Protocol.prototype.set_option_command = function(opt) {
    return this.simple_command(pack.pack("Cv", constants.com.SET_OPTION, opt));
}

// send simple command
Protocol.prototype.simple_command = function(packet) {
    var promise = new Promise();
    
    var err = scope(this, function(error) {
	this.set_state('READY');
	promise.emitError(error);
    });
    
    this.wait_ready_state(scope(this, function() {
	this.set_state('PROCESS');
	this.conn.reset();
	this.conn.write(packet)
	    .addCallback(scope(this, function() {
		this.conn.read()
		    .addCallback(scope(this, function() {
			this.set_state('READY');
			promise.emitSuccess();
		    }))
		    .addErrback(err);
	    }))
	    .addErrback(err);
    }));
    return promise;
}

// get field info
Protocol.prototype.retr_fields = function(nfields) {
    var promise = new Promise();
    if(!this.check_state('FIELD', promise)) return promise;
    
    var fields = [];
    for(var i=0; i<nfields; ++i) {
	this.conn.read()
	    .addCallback(scope(this, function(buff) {
		fields.push(packet.FieldPacket.parse(buff));
		if(fields.length>=nfields) {
		    this.read_eof_packet()
			.addCallback(scope(this, function(buff) {
			    this.set_state('RESULT');
			    promise.emitSuccess(fields);
			}))
			.addErrback(scope(function(error) {
			    this.set_state('READY');
			    promise.emitError(error);
			}));
		}
	    }))
	    .addErrback(scope(this, function(error) {
		this.set_state('READY');
		promise.emitError(error);
	    }));
    }
    
    return promise;
}

// 
Protocol.prototype.read_eof_packet = function(nfields) {
    var promise = new Promise();
    this.conn.read()
	.addCallback(scope(this, function(buff) {
	    if(is_eof_packet(buff)) {
		promise.emitSuccess();
	    }
	    else {
		promise.emitError(new errors.ProtocolError("packet is not EOF"));
	    }
	}))
	.addErrback(scope(function(error) {
	    promise.emitError(error);
	}));
    return promise;
};

var is_eof_packet = function(data) {
    return data.substring(0,1)=="\xfe" && data.length==5;
}

Protocol.prototype.retr_all_records = function(fields, each_callback, end_callback) {
    var promise = new Promise();
    if(!this.check_state('RESULT', promise)) return promise;
    var get_line = scope(this, function() {
	this.conn.read()
	    .addCallback(scope(this, function(data) {
		if(is_eof_packet(data)) {
		    this.server_status = data.charCodeAt(3);
		    this.set_state('READY');
		    promise.emitSuccess(end_callback());
		}
		else {
		    var rec = [], adata = [data];
		    for(var i=0; i<fields.length; ++i) {
			var val = lcs2str(adata);
			rec.push(fields[i].type.convert(val, this.charset, fields[i]));
		    }
		    each_callback(rec);
		    get_line();
		}
	    }))
	    .addErrback(scope(this, function(error) {
		this.set_state('READY');
		promise.emitError(error);
            }));
    });
    get_line();
    return promise;
}

Protocol.prototype.stmt_prepare_command = function(stmt) {
    var promise = new Promise();

    this.wait_ready_state(scope(this, function() {
	this.set_state('PROCESS');
	
	this.conn.reset();
	this.conn.write(pack.pack("Ca*", constants.com.STMT_PREPARE, this.charset.convertToBytes(stmt)))
	this.conn.read()
            .addCallback(scope(this, function(buff) {
		var res_packet = packet.PrepareResultPacket.parse(buff);
		var func = scope(this, function() {
		    if(res_packet.field_count > 0) {
			this.conn.read(res_packet.field_count) // skip parameter packet
		            .addCallback(scope(this, function(packets) {
				field_packets = [];
				for(var i=0; i<res_packet.field_count; ++i) {
				    field_packets.push(packet.FieldPacket.parse(packets[i]));
				}
				this.read_eof_packet()
				    .addCallback(scope(this, function() {
					promise.emitSuccess(res_packet.statement_id, res_packet.param_count, field_packets);
				    }))
				    .addErrback(function(error) {
					promise.emitError(error);
				    });
			    }))
			    .addErrback(function(error) {
				promise.emitError(error);
			    });
		    }
		    else {
			promise.emitSuccess(res_packet.statement_id, res_packet.param_count, []);
		    }
		});
		
		if(res_packet.param_count > 0) {
		    this.conn.read(res_packet.param_count) // skip parameter packet
		        .addCallback(scope(this, function(){
			    this.read_eof_packet()
				.addCallback(scope(this, function() {
				    func();
				}));
			}));
		}
		else {
		    func();
		}
	    }))
            .addErrback(function(error) {
		promise.emitError(error);
	    });
    }));
    return promise;
}

Protocol.prototype.stmt_close_command = function(stmt_id) {
    if(typeof(stmt_id)!='undefined') {
	this.conn.reset();
	this.conn.write(pack.pack("CV", constants.com.STMT_CLOSE, stmt_id));
    }
}

Protocol.prototype.stmt_execute_command = function(stmt_id, values) {
    var promise = new Promise();
    
    var err = scope(this, function(error) {
	this.set_state('READY');
	promise.emitError(error);
    });
    
    this.check_state('READY');
    this.conn.reset();
    this.conn.write(packet.ExecutePacket.serialize(stmt_id, constants.stmt.CURSOR_TYPE_NO_CURSOR, values, this.charset));
    this.get_result()
        .addCallback(function(nfields) {
	    promise.emitSuccess(nfields);
	})
        .addErrback(err);
    
    return promise;
}

Protocol.prototype.stmt_retr_all_records = function(fields, charset) {
    var promise = new Promise();
    
    this.check_state('RESULT');
    var all_recs = [];
    var err = scope(this, function(error) {
	this.set_state('READY');
	promise.emitError(error);
    });
    var func = scope(this, function() {
	this.conn.read()
	    .addCallback(scope(this, function(buff) {
		if(is_eof_packet(buff)) {	
		    this.set_state('READY');
		    promise.emitSuccess(all_recs);
		}
		else {
		    all_recs.push(packet.StatementRecordPacket.parse(buff, fields, this.charset));
		    func();
		}
	    }))
	    .addErrback(err);
    });
    func();
    return promise;
}

// set protocol state
Protocol.prototype.set_state = function(state) {
    if(this.state == state) return;
    this.state = state;
    if(state=='READY') {
	while(st = this.gc_stmt_queue.shift()) {
	    this.stmt_close_command(st);
	}
	if(this.ready_state_queue.length>0) {
	    var callback = this.ready_state_queue.shift();
	    process.nextTick(callback);
	}
    }
}

// check protocol state
Protocol.prototype.check_state = function(st, promise) {
    if(this.state==st) {
	return true;
    }
    else {
	if(promise) promise.emitError(new errors.ProtocolError("Unmatch protocol state "+st+"(expect) != "+this.state));
	return false;
    }
}

// wait changing to state
Protocol.prototype.wait_ready_state = function(callback, immediately) {
    if(immediately) {
	this.ready_state_queue.unshift(callback);
    }
    else {
	this.ready_state_queue.push(callback);
    }
    if(this.state=='READY') {
	process.nextTick(this.ready_state_queue.shift());
    }
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
