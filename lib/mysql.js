// Connection:
// MySQL connection
var sys = require('sys');
var events = require('events');
var result = require('./mysql/result');
var types = require('./mysql/types');
var errors = require('./mysql/errors');
var Promise = require('./mysql/node-promise').Promise;
var Protocol = require('./mysql/protocol').Protocol;
process.mixin(require('./mysql/common'));
var constants = require('./mysql/constants')
exports.constants = constants;

exports.Time = types.Time;
exports.quote = types.quote;

var Connection = function(hostname, username, password, dbname, port) {
    events.EventEmitter.call(this);
    this.protocol = undefined;
    this.active = false;
    this.connect_parameter = Array.prototype.slice.call(arguments);
}
sys.inherits(Connection, events.EventEmitter);
exports.Connection = Connection;

Connection.prototype.connect = function(callback, errback) {
    this.protocol = new Protocol(this.connect_parameter[0], this.connect_parameter[4]);
    this.protocol.addListener('connect', scope(this, function() {	
	this.active = false;
	this.emit('connect');
    }));
    this.protocol.addListener('close', scope(this, function() {	
	this.active = false;
	this.emit('close');
    }));
    this.protocol.addListener('authorized', scope(this, function() {	
	this.active = true;
	this.emit('authorized');

    }));
    this.protocol.addListener('authorize error', scope(this, function() {	
	this.active = false;
	this.emit('authorize error');
    }));
    this.protocol.authenticate(this.connect_parameter[1], this.connect_parameter[2], this.connect_parameter[3], undefined, 'utf8_general_ci').addCallback(callback).addErrback(errback);
}

Connection.prototype.close = function() {
    this.protocol.close();
}

Connection.prototype.option = function(option) {
    this.protocol.close();
}

Connection.prototype.query = function(sql, callback, errback) {
    var sql = this.extract_placeholder(sql);
    if(sql.constructor==errors.ClientError.prototype.constructor) {
	errback(sql);
	return;
    }
    this.protocol.query_command(sql)
	.addCallback(scope(this, function(nfields) {
	    if(nfields) {
		this.protocol.retr_fields(nfields)
		    .addCallback(scope(this, function(fields) {
			this.fields = fields;
			this.get_result()
			    .addCallback(scope(this, function(rows) {
				this.server_status = this.protocol.server_status;
				callback(rows);
			    }))
			    .addErrback(scope(this, function(error) {
				errback(error);
			    }));
		    }))
		    .addErrback(scope(this, function(error) {
			errback(error);
		    }));
	    }
	    else {
		this.affected_rows = this.protocol.affected_rows;
		this.insert_id = this.protocol.insert_id;
		this.server_status = this.protocol.server_status;
		this.warning_count = this.protocol.warning_count;
		this.info = this.protocol.message;
		if(callback) callback();
		// TODO
	    }
	}))
	.addErrback(scope(this, function(error) {
	    errback(error);
	}));
}

Connection.prototype.extract_placeholder = function(sql) {
    if(typeof(sql)=='string') return sql;
    
    var format = sql[0];
    var bind = sql.slice(1).map(function(v) {
	return types.convertToSQLString(v);
    });
    if(format.match(/\?/g).length!=bind.length) {
	return new errors.ClientError('parameter count mismatch');
    }
    return format.replace(/\?/g, function() {
	return bind.shift();
    });
}

Connection.prototype.set_server_option = function(opt) {
    return this.protocol.set_option_command(opt);
}

Connection.prototype.get_result = function(fields) {
    var res = new result.Result(this.fields.map(function(field) {
	return(new Field(field));
    }), this.protocol);
    return res.fetch_all();
}

Connection.prototype.has_more_results = function() {
    return !!(this.protocol.server_status & constants.server.MORE_RESULTS_EXISTS);
}

Connection.prototype.next_result = function(callback, errback) {
    if(!this.has_more_results()) {
	process.nextTick(new Error("ClientError", "Don't have more results"));
	return;
    }
    this.protocol.get_result()
	.addCallback(scope(this, function(nfields) {
	    this.protocol.retr_fields(nfields)
		.addCallback(scope(this, function(fields) {
		    this.fields = fields;
		    this.result_exist = true;
		    this.get_result()
			.addCallback(scope(this, function(results) {
			    callback(results);
			}))
			.addErrback(scope(this, function(error) {
			    errback(error);
			}));
		}))
		.addErrback(scope(this, function(error) {
		    errback(error);
		}));
	}))
	.addErrback(scope(this, function(error) {
	    errback(error);
	}));
}

Connection.prototype.prepare = function(str, callback, errback) {
    var stmt = new Stmt(this.protocol, this.charset);
    return stmt.prepare(str, callback, errback);
};


var Stmt = function(protocol, charset) {
    this.protocol = protocol;
    this.charset = charset;
    this.statement_id = undefined;
    this.affected_rows = this.insert_id = this.server_status = this.warning_count = 0;
    this.sqlstate = "00000";
    this.param_count = undefined;
}

Stmt.prototype.close = function() {
    this.protocol.stmt_close_command(this.statement_id);
    this.statement_id = undefined;
}

Stmt.prototype.prepare = function(query, callback, errback) {
    this.close();
    this.protocol.stmt_prepare_command(query)
        .addCallback(scope(this, function(statement_id, param_count, field_packets) {
	    this.statement_id = statement_id;
            this.sqlstate = "00000";
	    this.fields = field_packets.map(function(field_packet) {
		return new Field(field_packet);
	    });
	    callback(this);
        }))
        .addErrback(scope(this, function(error) {
	    errback(error);
	}));
}

Stmt.prototype.execute = function(args, callback, errback) {
    //raise ClientError, "not prepared" unless @param_count
    //raise ClientError, "parameter count mismatch" if values.length != @param_count
    //values = values.map{|v| @charset.convert v}
    //begin
    this.sqlstate = "00000";
    this.protocol.stmt_execute_command(this.statement_id, args)
        .addCallback(scope(this, function(nfields) {
            if(typeof(nfields)!='undefined') {
		this.protocol.retr_fields(nfields)
		    .addCallback(scope(this, function(fields) {
			this.fields = fields;
			this.result = new result.StatementResult(this.fields, this.protocol);
			this.protocol.stmt_retr_all_records(fields, this.charset)
			    .addCallback(scope(this, function(records) {
				this.result.records = records;
				callback(this.result);
			    }))
			    .addErrback(scope(this, function(error) {
				errback(error);
			    }));
			
		    }))
		    .addErrback(scope(this, function(error) {
			errback(error);
		    }));
	    }
	    else {
		this.affected_rows = this.protocol.affected_rows;
		this.insert_id = this.protocol.insert_id;
		this.server_status = this.protocol.server_status;
		this.warning_count = this.protocol.warning_count;
		this.info = this.protocol.message;
		callback();
	    }
	}));
      //rescue ServerError => e
      //  @last_error = e
      //  @sqlstate = e.sqlstate
      //  raise
      //end
}


var Field = function(packet) {
    this.db = packet.db;
    this.table = packet.table;
    this.org_table = packet.org_table;
    this.name = packet.name;
    this.org_name = packet.org_name;
    this.charsetnr = packet.charsetnr;
    this.length = packet.length;
    this.type = packet.type;
    this.flags = packet.flags;
    this.decimals = packet.decimals;
    this.defaultVal = packet.defaultVal;
}
exports.Field = Field;

Field.prototype.is_num = function() {
    return [constants.field.TYPE_DECIMAL, constants.field.TYPE_TINY, constants.field.TYPE_SHORT, constants.field.TYPE_LONG, constants.field.TYPE_FLOAT, constants.field.TYPE_DOUBLE, constants.field.TYPE_LONGLONG, constants.field.TYPE_INT24].indexOf(this.type.id) >= 0;
}

Field.prototype.is_not_null = function() {
    return !!(this.flags & constants.field.NOT_NULL_FLAG);
}

Field.prototype.is_pri_key = function() {
    return !!(this.flags & constants.field.PRI_KEY_FLAG);
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
