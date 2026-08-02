// @bun
var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toESMCache_node;
var __toESMCache_esm;
var __toESM = (mod, isNodeMode, target) => {
  var canCache = mod != null && typeof mod === "object";
  if (canCache) {
    var cache = isNodeMode ? __toESMCache_node ??= new WeakMap : __toESMCache_esm ??= new WeakMap;
    var cached = cache.get(mod);
    if (cached)
      return cached;
  }
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  for (let key of __getOwnPropNames(mod))
    if (!__hasOwnProp.call(to, key))
      __defProp(to, key, {
        get: __accessProp.bind(mod, key),
        enumerable: true
      });
  if (canCache)
    cache.set(mod, to);
  return to;
};
var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};
var __esm = (fn, res) => () => (fn && (res = fn(fn = 0)), res);
var __require = import.meta.require;

// ../utils/src/path.ts
var init_path = () => {};

// ../utils/src/worker-host.ts
function installWorkerInbox(port) {
  const queue = [];
  let handler = null;
  port.on("message", (data) => {
    if (handler)
      handler(data);
    else
      queue.push(data);
  });
  const inbox = {
    bind(next) {
      handler = next;
      for (const data of queue)
        next(data);
      queue.length = 0;
      return () => {
        if (handler === next)
          handler = null;
      };
    }
  };
  pendingInbox = inbox;
  return inbox;
}
function consumeWorkerInbox() {
  const inbox = pendingInbox;
  pendingInbox = null;
  return inbox;
}
var pendingInbox = null;
var init_worker_host = __esm(() => {
  init_path();
});

// src/tools/computer/protocol.ts
var COMPUTER_WORKER_ARG = "__omp_worker_computer";

// ../../node_modules/object-hash/index.js
var require_object_hash = __commonJS((exports, module) => {
  var crypto2 = __require("crypto");
  exports = module.exports = objectHash;
  function objectHash(object, options) {
    options = applyDefaults(object, options);
    return hash(object, options);
  }
  exports.sha1 = function(object) {
    return objectHash(object);
  };
  exports.keys = function(object) {
    return objectHash(object, { excludeValues: true, algorithm: "sha1", encoding: "hex" });
  };
  exports.MD5 = function(object) {
    return objectHash(object, { algorithm: "md5", encoding: "hex" });
  };
  exports.keysMD5 = function(object) {
    return objectHash(object, { algorithm: "md5", encoding: "hex", excludeValues: true });
  };
  var hashes = crypto2.getHashes ? crypto2.getHashes().slice() : ["sha1", "md5"];
  hashes.push("passthrough");
  var encodings = ["buffer", "hex", "binary", "base64"];
  function applyDefaults(object, sourceOptions) {
    sourceOptions = sourceOptions || {};
    var options = {};
    options.algorithm = sourceOptions.algorithm || "sha1";
    options.encoding = sourceOptions.encoding || "hex";
    options.excludeValues = sourceOptions.excludeValues ? true : false;
    options.algorithm = options.algorithm.toLowerCase();
    options.encoding = options.encoding.toLowerCase();
    options.ignoreUnknown = sourceOptions.ignoreUnknown !== true ? false : true;
    options.respectType = sourceOptions.respectType === false ? false : true;
    options.respectFunctionNames = sourceOptions.respectFunctionNames === false ? false : true;
    options.respectFunctionProperties = sourceOptions.respectFunctionProperties === false ? false : true;
    options.unorderedArrays = sourceOptions.unorderedArrays !== true ? false : true;
    options.unorderedSets = sourceOptions.unorderedSets === false ? false : true;
    options.unorderedObjects = sourceOptions.unorderedObjects === false ? false : true;
    options.replacer = sourceOptions.replacer || undefined;
    options.excludeKeys = sourceOptions.excludeKeys || undefined;
    if (typeof object === "undefined") {
      throw new Error("Object argument required.");
    }
    for (var i = 0;i < hashes.length; ++i) {
      if (hashes[i].toLowerCase() === options.algorithm.toLowerCase()) {
        options.algorithm = hashes[i];
      }
    }
    if (hashes.indexOf(options.algorithm) === -1) {
      throw new Error('Algorithm "' + options.algorithm + '"  not supported. ' + "supported values: " + hashes.join(", "));
    }
    if (encodings.indexOf(options.encoding) === -1 && options.algorithm !== "passthrough") {
      throw new Error('Encoding "' + options.encoding + '"  not supported. ' + "supported values: " + encodings.join(", "));
    }
    return options;
  }
  function isNativeFunction(f) {
    if (typeof f !== "function") {
      return false;
    }
    var exp = /^function\s+\w*\s*\(\s*\)\s*{\s+\[native code\]\s+}$/i;
    return exp.exec(Function.prototype.toString.call(f)) != null;
  }
  function hash(object, options) {
    var hashingStream;
    if (options.algorithm !== "passthrough") {
      hashingStream = crypto2.createHash(options.algorithm);
    } else {
      hashingStream = new PassThrough;
    }
    if (typeof hashingStream.write === "undefined") {
      hashingStream.write = hashingStream.update;
      hashingStream.end = hashingStream.update;
    }
    var hasher = typeHasher(options, hashingStream);
    hasher.dispatch(object);
    if (!hashingStream.update) {
      hashingStream.end("");
    }
    if (hashingStream.digest) {
      return hashingStream.digest(options.encoding === "buffer" ? undefined : options.encoding);
    }
    var buf = hashingStream.read();
    if (options.encoding === "buffer") {
      return buf;
    }
    return buf.toString(options.encoding);
  }
  exports.writeToStream = function(object, options, stream) {
    if (typeof stream === "undefined") {
      stream = options;
      options = {};
    }
    options = applyDefaults(object, options);
    return typeHasher(options, stream).dispatch(object);
  };
  function typeHasher(options, writeTo, context) {
    context = context || [];
    var write = function(str) {
      if (writeTo.update) {
        return writeTo.update(str, "utf8");
      } else {
        return writeTo.write(str, "utf8");
      }
    };
    return {
      dispatch: function(value) {
        if (options.replacer) {
          value = options.replacer(value);
        }
        var type = typeof value;
        if (value === null) {
          type = "null";
        }
        return this["_" + type](value);
      },
      _object: function(object) {
        var pattern = /\[object (.*)\]/i;
        var objString = Object.prototype.toString.call(object);
        var objType = pattern.exec(objString);
        if (!objType) {
          objType = "unknown:[" + objString + "]";
        } else {
          objType = objType[1];
        }
        objType = objType.toLowerCase();
        var objectNumber = null;
        if ((objectNumber = context.indexOf(object)) >= 0) {
          return this.dispatch("[CIRCULAR:" + objectNumber + "]");
        } else {
          context.push(object);
        }
        if (typeof Buffer !== "undefined" && Buffer.isBuffer && Buffer.isBuffer(object)) {
          write("buffer:");
          return write(object);
        }
        if (objType !== "object" && objType !== "function" && objType !== "asyncfunction") {
          if (this["_" + objType]) {
            this["_" + objType](object);
          } else if (options.ignoreUnknown) {
            return write("[" + objType + "]");
          } else {
            throw new Error('Unknown object type "' + objType + '"');
          }
        } else {
          var keys = Object.keys(object);
          if (options.unorderedObjects) {
            keys = keys.sort();
          }
          if (options.respectType !== false && !isNativeFunction(object)) {
            keys.splice(0, 0, "prototype", "__proto__", "constructor");
          }
          if (options.excludeKeys) {
            keys = keys.filter(function(key) {
              return !options.excludeKeys(key);
            });
          }
          write("object:" + keys.length + ":");
          var self2 = this;
          return keys.forEach(function(key) {
            self2.dispatch(key);
            write(":");
            if (!options.excludeValues) {
              self2.dispatch(object[key]);
            }
            write(",");
          });
        }
      },
      _array: function(arr, unordered) {
        unordered = typeof unordered !== "undefined" ? unordered : options.unorderedArrays !== false;
        var self2 = this;
        write("array:" + arr.length + ":");
        if (!unordered || arr.length <= 1) {
          return arr.forEach(function(entry) {
            return self2.dispatch(entry);
          });
        }
        var contextAdditions = [];
        var entries = arr.map(function(entry) {
          var strm = new PassThrough;
          var localContext = context.slice();
          var hasher = typeHasher(options, strm, localContext);
          hasher.dispatch(entry);
          contextAdditions = contextAdditions.concat(localContext.slice(context.length));
          return strm.read().toString();
        });
        context = context.concat(contextAdditions);
        entries.sort();
        return this._array(entries, false);
      },
      _date: function(date) {
        return write("date:" + date.toJSON());
      },
      _symbol: function(sym) {
        return write("symbol:" + sym.toString());
      },
      _error: function(err) {
        return write("error:" + err.toString());
      },
      _boolean: function(bool) {
        return write("bool:" + bool.toString());
      },
      _string: function(string) {
        write("string:" + string.length + ":");
        write(string.toString());
      },
      _function: function(fn) {
        write("fn:");
        if (isNativeFunction(fn)) {
          this.dispatch("[native]");
        } else {
          this.dispatch(fn.toString());
        }
        if (options.respectFunctionNames !== false) {
          this.dispatch("function-name:" + String(fn.name));
        }
        if (options.respectFunctionProperties) {
          this._object(fn);
        }
      },
      _number: function(number) {
        return write("number:" + number.toString());
      },
      _xml: function(xml) {
        return write("xml:" + xml.toString());
      },
      _null: function() {
        return write("Null");
      },
      _undefined: function() {
        return write("Undefined");
      },
      _regexp: function(regex) {
        return write("regex:" + regex.toString());
      },
      _uint8array: function(arr) {
        write("uint8array:");
        return this.dispatch(Array.prototype.slice.call(arr));
      },
      _uint8clampedarray: function(arr) {
        write("uint8clampedarray:");
        return this.dispatch(Array.prototype.slice.call(arr));
      },
      _int8array: function(arr) {
        write("int8array:");
        return this.dispatch(Array.prototype.slice.call(arr));
      },
      _uint16array: function(arr) {
        write("uint16array:");
        return this.dispatch(Array.prototype.slice.call(arr));
      },
      _int16array: function(arr) {
        write("int16array:");
        return this.dispatch(Array.prototype.slice.call(arr));
      },
      _uint32array: function(arr) {
        write("uint32array:");
        return this.dispatch(Array.prototype.slice.call(arr));
      },
      _int32array: function(arr) {
        write("int32array:");
        return this.dispatch(Array.prototype.slice.call(arr));
      },
      _float32array: function(arr) {
        write("float32array:");
        return this.dispatch(Array.prototype.slice.call(arr));
      },
      _float64array: function(arr) {
        write("float64array:");
        return this.dispatch(Array.prototype.slice.call(arr));
      },
      _arraybuffer: function(arr) {
        write("arraybuffer:");
        return this.dispatch(new Uint8Array(arr));
      },
      _url: function(url) {
        return write("url:" + url.toString(), "utf8");
      },
      _map: function(map) {
        write("map:");
        var arr = Array.from(map);
        return this._array(arr, options.unorderedSets !== false);
      },
      _set: function(set) {
        write("set:");
        var arr = Array.from(set);
        return this._array(arr, options.unorderedSets !== false);
      },
      _file: function(file) {
        write("file:");
        return this.dispatch([file.name, file.size, file.type, file.lastModfied]);
      },
      _blob: function() {
        if (options.ignoreUnknown) {
          return write("[blob]");
        }
        throw Error(`Hashing Blob objects is currently not supported
` + `(see https://github.com/puleos/object-hash/issues/26)
` + `Use "options.replacer" or "options.ignoreUnknown"
`);
      },
      _domwindow: function() {
        return write("domwindow");
      },
      _bigint: function(number) {
        return write("bigint:" + number.toString());
      },
      _process: function() {
        return write("process");
      },
      _timer: function() {
        return write("timer");
      },
      _pipe: function() {
        return write("pipe");
      },
      _tcp: function() {
        return write("tcp");
      },
      _udp: function() {
        return write("udp");
      },
      _tty: function() {
        return write("tty");
      },
      _statwatcher: function() {
        return write("statwatcher");
      },
      _securecontext: function() {
        return write("securecontext");
      },
      _connection: function() {
        return write("connection");
      },
      _zlib: function() {
        return write("zlib");
      },
      _context: function() {
        return write("context");
      },
      _nodescript: function() {
        return write("nodescript");
      },
      _httpparser: function() {
        return write("httpparser");
      },
      _dataview: function() {
        return write("dataview");
      },
      _signal: function() {
        return write("signal");
      },
      _fsevent: function() {
        return write("fsevent");
      },
      _tlswrap: function() {
        return write("tlswrap");
      }
    };
  }
  function PassThrough() {
    return {
      buf: "",
      write: function(b) {
        this.buf += b;
      },
      end: function(b) {
        this.buf += b;
      },
      read: function() {
        return this.buf;
      }
    };
  }
});

// ../../node_modules/triple-beam/config/cli.js
var require_cli = __commonJS((exports) => {
  exports.levels = {
    error: 0,
    warn: 1,
    help: 2,
    data: 3,
    info: 4,
    debug: 5,
    prompt: 6,
    verbose: 7,
    input: 8,
    silly: 9
  };
  exports.colors = {
    error: "red",
    warn: "yellow",
    help: "cyan",
    data: "grey",
    info: "green",
    debug: "blue",
    prompt: "grey",
    verbose: "cyan",
    input: "grey",
    silly: "magenta"
  };
});

// ../../node_modules/triple-beam/config/npm.js
var require_npm = __commonJS((exports) => {
  exports.levels = {
    error: 0,
    warn: 1,
    info: 2,
    http: 3,
    verbose: 4,
    debug: 5,
    silly: 6
  };
  exports.colors = {
    error: "red",
    warn: "yellow",
    info: "green",
    http: "green",
    verbose: "cyan",
    debug: "blue",
    silly: "magenta"
  };
});

// ../../node_modules/triple-beam/config/syslog.js
var require_syslog = __commonJS((exports) => {
  exports.levels = {
    emerg: 0,
    alert: 1,
    crit: 2,
    error: 3,
    warning: 4,
    notice: 5,
    info: 6,
    debug: 7
  };
  exports.colors = {
    emerg: "red",
    alert: "yellow",
    crit: "red",
    error: "red",
    warning: "red",
    notice: "yellow",
    info: "green",
    debug: "blue"
  };
});

// ../../node_modules/triple-beam/config/index.js
var require_config = __commonJS((exports) => {
  Object.defineProperty(exports, "cli", {
    value: require_cli()
  });
  Object.defineProperty(exports, "npm", {
    value: require_npm()
  });
  Object.defineProperty(exports, "syslog", {
    value: require_syslog()
  });
});

// ../../node_modules/triple-beam/index.js
var require_triple_beam = __commonJS((exports) => {
  Object.defineProperty(exports, "LEVEL", {
    value: Symbol.for("level")
  });
  Object.defineProperty(exports, "MESSAGE", {
    value: Symbol.for("message")
  });
  Object.defineProperty(exports, "SPLAT", {
    value: Symbol.for("splat")
  });
  Object.defineProperty(exports, "configs", {
    value: require_config()
  });
});

// ../../node_modules/util-deprecate/node.js
var require_node = __commonJS((exports, module) => {
  module.exports = __require("util").deprecate;
});

// ../../node_modules/readable-stream/lib/internal/streams/destroy.js
var require_destroy = __commonJS((exports, module) => {
  function destroy(err, cb) {
    var _this = this;
    var readableDestroyed = this._readableState && this._readableState.destroyed;
    var writableDestroyed = this._writableState && this._writableState.destroyed;
    if (readableDestroyed || writableDestroyed) {
      if (cb) {
        cb(err);
      } else if (err) {
        if (!this._writableState) {
          process.nextTick(emitErrorNT, this, err);
        } else if (!this._writableState.errorEmitted) {
          this._writableState.errorEmitted = true;
          process.nextTick(emitErrorNT, this, err);
        }
      }
      return this;
    }
    if (this._readableState) {
      this._readableState.destroyed = true;
    }
    if (this._writableState) {
      this._writableState.destroyed = true;
    }
    this._destroy(err || null, function(err2) {
      if (!cb && err2) {
        if (!_this._writableState) {
          process.nextTick(emitErrorAndCloseNT, _this, err2);
        } else if (!_this._writableState.errorEmitted) {
          _this._writableState.errorEmitted = true;
          process.nextTick(emitErrorAndCloseNT, _this, err2);
        } else {
          process.nextTick(emitCloseNT, _this);
        }
      } else if (cb) {
        process.nextTick(emitCloseNT, _this);
        cb(err2);
      } else {
        process.nextTick(emitCloseNT, _this);
      }
    });
    return this;
  }
  function emitErrorAndCloseNT(self2, err) {
    emitErrorNT(self2, err);
    emitCloseNT(self2);
  }
  function emitCloseNT(self2) {
    if (self2._writableState && !self2._writableState.emitClose)
      return;
    if (self2._readableState && !self2._readableState.emitClose)
      return;
    self2.emit("close");
  }
  function undestroy() {
    if (this._readableState) {
      this._readableState.destroyed = false;
      this._readableState.reading = false;
      this._readableState.ended = false;
      this._readableState.endEmitted = false;
    }
    if (this._writableState) {
      this._writableState.destroyed = false;
      this._writableState.ended = false;
      this._writableState.ending = false;
      this._writableState.finalCalled = false;
      this._writableState.prefinished = false;
      this._writableState.finished = false;
      this._writableState.errorEmitted = false;
    }
  }
  function emitErrorNT(self2, err) {
    self2.emit("error", err);
  }
  function errorOrDestroy(stream, err) {
    var rState = stream._readableState;
    var wState = stream._writableState;
    if (rState && rState.autoDestroy || wState && wState.autoDestroy)
      stream.destroy(err);
    else
      stream.emit("error", err);
  }
  module.exports = {
    destroy,
    undestroy,
    errorOrDestroy
  };
});

// ../../node_modules/readable-stream/errors.js
var require_errors = __commonJS((exports, module) => {
  var codes = {};
  function createErrorType(code, message, Base) {
    if (!Base) {
      Base = Error;
    }
    function getMessage(arg1, arg2, arg3) {
      if (typeof message === "string") {
        return message;
      } else {
        return message(arg1, arg2, arg3);
      }
    }

    class NodeError extends Base {
      constructor(arg1, arg2, arg3) {
        super(getMessage(arg1, arg2, arg3));
      }
    }
    NodeError.prototype.name = Base.name;
    NodeError.prototype.code = code;
    codes[code] = NodeError;
  }
  function oneOf(expected, thing) {
    if (Array.isArray(expected)) {
      const len = expected.length;
      expected = expected.map((i) => String(i));
      if (len > 2) {
        return `one of ${thing} ${expected.slice(0, len - 1).join(", ")}, or ` + expected[len - 1];
      } else if (len === 2) {
        return `one of ${thing} ${expected[0]} or ${expected[1]}`;
      } else {
        return `of ${thing} ${expected[0]}`;
      }
    } else {
      return `of ${thing} ${String(expected)}`;
    }
  }
  function startsWith(str, search, pos) {
    return str.substr(!pos || pos < 0 ? 0 : +pos, search.length) === search;
  }
  function endsWith(str, search, this_len) {
    if (this_len === undefined || this_len > str.length) {
      this_len = str.length;
    }
    return str.substring(this_len - search.length, this_len) === search;
  }
  function includes(str, search, start) {
    if (typeof start !== "number") {
      start = 0;
    }
    if (start + search.length > str.length) {
      return false;
    } else {
      return str.indexOf(search, start) !== -1;
    }
  }
  createErrorType("ERR_INVALID_OPT_VALUE", function(name, value) {
    return 'The value "' + value + '" is invalid for option "' + name + '"';
  }, TypeError);
  createErrorType("ERR_INVALID_ARG_TYPE", function(name, expected, actual) {
    let determiner;
    if (typeof expected === "string" && startsWith(expected, "not ")) {
      determiner = "must not be";
      expected = expected.replace(/^not /, "");
    } else {
      determiner = "must be";
    }
    let msg;
    if (endsWith(name, " argument")) {
      msg = `The ${name} ${determiner} ${oneOf(expected, "type")}`;
    } else {
      const type = includes(name, ".") ? "property" : "argument";
      msg = `The "${name}" ${type} ${determiner} ${oneOf(expected, "type")}`;
    }
    msg += `. Received type ${typeof actual}`;
    return msg;
  }, TypeError);
  createErrorType("ERR_STREAM_PUSH_AFTER_EOF", "stream.push() after EOF");
  createErrorType("ERR_METHOD_NOT_IMPLEMENTED", function(name) {
    return "The " + name + " method is not implemented";
  });
  createErrorType("ERR_STREAM_PREMATURE_CLOSE", "Premature close");
  createErrorType("ERR_STREAM_DESTROYED", function(name) {
    return "Cannot call " + name + " after a stream was destroyed";
  });
  createErrorType("ERR_MULTIPLE_CALLBACK", "Callback called multiple times");
  createErrorType("ERR_STREAM_CANNOT_PIPE", "Cannot pipe, not readable");
  createErrorType("ERR_STREAM_WRITE_AFTER_END", "write after end");
  createErrorType("ERR_STREAM_NULL_VALUES", "May not write null values to stream", TypeError);
  createErrorType("ERR_UNKNOWN_ENCODING", function(arg) {
    return "Unknown encoding: " + arg;
  }, TypeError);
  createErrorType("ERR_STREAM_UNSHIFT_AFTER_END_EVENT", "stream.unshift() after end event");
  exports.codes = codes;
});

// ../../node_modules/readable-stream/lib/internal/streams/state.js
var require_state = __commonJS((exports, module) => {
  var ERR_INVALID_OPT_VALUE = require_errors().codes.ERR_INVALID_OPT_VALUE;
  function highWaterMarkFrom(options, isDuplex, duplexKey) {
    return options.highWaterMark != null ? options.highWaterMark : isDuplex ? options[duplexKey] : null;
  }
  function getHighWaterMark(state, options, duplexKey, isDuplex) {
    var hwm = highWaterMarkFrom(options, isDuplex, duplexKey);
    if (hwm != null) {
      if (!(isFinite(hwm) && Math.floor(hwm) === hwm) || hwm < 0) {
        var name = isDuplex ? duplexKey : "highWaterMark";
        throw new ERR_INVALID_OPT_VALUE(name, hwm);
      }
      return Math.floor(hwm);
    }
    return state.objectMode ? 16 : 16 * 1024;
  }
  module.exports = {
    getHighWaterMark
  };
});

// ../../node_modules/inherits/inherits_browser.js
var require_inherits_browser = __commonJS((exports, module) => {
  if (typeof Object.create === "function") {
    module.exports = function inherits(ctor, superCtor) {
      if (superCtor) {
        ctor.super_ = superCtor;
        ctor.prototype = Object.create(superCtor.prototype, {
          constructor: {
            value: ctor,
            enumerable: false,
            writable: true,
            configurable: true
          }
        });
      }
    };
  } else {
    module.exports = function inherits(ctor, superCtor) {
      if (superCtor) {
        ctor.super_ = superCtor;
        var TempCtor = function() {};
        TempCtor.prototype = superCtor.prototype;
        ctor.prototype = new TempCtor;
        ctor.prototype.constructor = ctor;
      }
    };
  }
});

// ../../node_modules/inherits/inherits.js
var require_inherits = __commonJS((exports, module) => {
  try {
    util = __require("util");
    if (typeof util.inherits !== "function")
      throw "";
    module.exports = util.inherits;
  } catch (e) {
    module.exports = require_inherits_browser();
  }
  var util;
});

// ../../node_modules/readable-stream/lib/internal/streams/buffer_list.js
var require_buffer_list = __commonJS((exports, module) => {
  function ownKeys(object, enumerableOnly) {
    var keys = Object.keys(object);
    if (Object.getOwnPropertySymbols) {
      var symbols = Object.getOwnPropertySymbols(object);
      enumerableOnly && (symbols = symbols.filter(function(sym) {
        return Object.getOwnPropertyDescriptor(object, sym).enumerable;
      })), keys.push.apply(keys, symbols);
    }
    return keys;
  }
  function _objectSpread(target) {
    for (var i = 1;i < arguments.length; i++) {
      var source = arguments[i] != null ? arguments[i] : {};
      i % 2 ? ownKeys(Object(source), true).forEach(function(key) {
        _defineProperty(target, key, source[key]);
      }) : Object.getOwnPropertyDescriptors ? Object.defineProperties(target, Object.getOwnPropertyDescriptors(source)) : ownKeys(Object(source)).forEach(function(key) {
        Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(source, key));
      });
    }
    return target;
  }
  function _defineProperty(obj, key, value) {
    key = _toPropertyKey(key);
    if (key in obj) {
      Object.defineProperty(obj, key, { value, enumerable: true, configurable: true, writable: true });
    } else {
      obj[key] = value;
    }
    return obj;
  }
  function _classCallCheck(instance, Constructor) {
    if (!(instance instanceof Constructor)) {
      throw new TypeError("Cannot call a class as a function");
    }
  }
  function _defineProperties(target, props) {
    for (var i = 0;i < props.length; i++) {
      var descriptor = props[i];
      descriptor.enumerable = descriptor.enumerable || false;
      descriptor.configurable = true;
      if ("value" in descriptor)
        descriptor.writable = true;
      Object.defineProperty(target, _toPropertyKey(descriptor.key), descriptor);
    }
  }
  function _createClass(Constructor, protoProps, staticProps) {
    if (protoProps)
      _defineProperties(Constructor.prototype, protoProps);
    if (staticProps)
      _defineProperties(Constructor, staticProps);
    Object.defineProperty(Constructor, "prototype", { writable: false });
    return Constructor;
  }
  function _toPropertyKey(arg) {
    var key = _toPrimitive(arg, "string");
    return typeof key === "symbol" ? key : String(key);
  }
  function _toPrimitive(input, hint) {
    if (typeof input !== "object" || input === null)
      return input;
    var prim = input[Symbol.toPrimitive];
    if (prim !== undefined) {
      var res = prim.call(input, hint || "default");
      if (typeof res !== "object")
        return res;
      throw new TypeError("@@toPrimitive must return a primitive value.");
    }
    return (hint === "string" ? String : Number)(input);
  }
  var _require = __require("buffer");
  var Buffer2 = _require.Buffer;
  var _require2 = __require("util");
  var inspect = _require2.inspect;
  var custom = inspect && inspect.custom || "inspect";
  function copyBuffer(src, target, offset) {
    Buffer2.prototype.copy.call(src, target, offset);
  }
  module.exports = /* @__PURE__ */ function() {
    function BufferList() {
      _classCallCheck(this, BufferList);
      this.head = null;
      this.tail = null;
      this.length = 0;
    }
    _createClass(BufferList, [{
      key: "push",
      value: function push(v) {
        var entry = {
          data: v,
          next: null
        };
        if (this.length > 0)
          this.tail.next = entry;
        else
          this.head = entry;
        this.tail = entry;
        ++this.length;
      }
    }, {
      key: "unshift",
      value: function unshift(v) {
        var entry = {
          data: v,
          next: this.head
        };
        if (this.length === 0)
          this.tail = entry;
        this.head = entry;
        ++this.length;
      }
    }, {
      key: "shift",
      value: function shift() {
        if (this.length === 0)
          return;
        var ret = this.head.data;
        if (this.length === 1)
          this.head = this.tail = null;
        else
          this.head = this.head.next;
        --this.length;
        return ret;
      }
    }, {
      key: "clear",
      value: function clear() {
        this.head = this.tail = null;
        this.length = 0;
      }
    }, {
      key: "join",
      value: function join(s) {
        if (this.length === 0)
          return "";
        var p = this.head;
        var ret = "" + p.data;
        while (p = p.next)
          ret += s + p.data;
        return ret;
      }
    }, {
      key: "concat",
      value: function concat(n) {
        if (this.length === 0)
          return Buffer2.alloc(0);
        var ret = Buffer2.allocUnsafe(n >>> 0);
        var p = this.head;
        var i = 0;
        while (p) {
          copyBuffer(p.data, ret, i);
          i += p.data.length;
          p = p.next;
        }
        return ret;
      }
    }, {
      key: "consume",
      value: function consume(n, hasStrings) {
        var ret;
        if (n < this.head.data.length) {
          ret = this.head.data.slice(0, n);
          this.head.data = this.head.data.slice(n);
        } else if (n === this.head.data.length) {
          ret = this.shift();
        } else {
          ret = hasStrings ? this._getString(n) : this._getBuffer(n);
        }
        return ret;
      }
    }, {
      key: "first",
      value: function first() {
        return this.head.data;
      }
    }, {
      key: "_getString",
      value: function _getString(n) {
        var p = this.head;
        var c = 1;
        var ret = p.data;
        n -= ret.length;
        while (p = p.next) {
          var str = p.data;
          var nb = n > str.length ? str.length : n;
          if (nb === str.length)
            ret += str;
          else
            ret += str.slice(0, n);
          n -= nb;
          if (n === 0) {
            if (nb === str.length) {
              ++c;
              if (p.next)
                this.head = p.next;
              else
                this.head = this.tail = null;
            } else {
              this.head = p;
              p.data = str.slice(nb);
            }
            break;
          }
          ++c;
        }
        this.length -= c;
        return ret;
      }
    }, {
      key: "_getBuffer",
      value: function _getBuffer(n) {
        var ret = Buffer2.allocUnsafe(n);
        var p = this.head;
        var c = 1;
        p.data.copy(ret);
        n -= p.data.length;
        while (p = p.next) {
          var buf = p.data;
          var nb = n > buf.length ? buf.length : n;
          buf.copy(ret, ret.length - n, 0, nb);
          n -= nb;
          if (n === 0) {
            if (nb === buf.length) {
              ++c;
              if (p.next)
                this.head = p.next;
              else
                this.head = this.tail = null;
            } else {
              this.head = p;
              p.data = buf.slice(nb);
            }
            break;
          }
          ++c;
        }
        this.length -= c;
        return ret;
      }
    }, {
      key: custom,
      value: function value(_, options) {
        return inspect(this, _objectSpread(_objectSpread({}, options), {}, {
          depth: 0,
          customInspect: false
        }));
      }
    }]);
    return BufferList;
  }();
});

// ../../node_modules/string_decoder/node_modules/safe-buffer/index.js
var require_safe_buffer = __commonJS((exports, module) => {
  /*! safe-buffer. MIT License. Feross Aboukhadijeh <https://feross.org/opensource> */
  var buffer = __require("buffer");
  var Buffer2 = buffer.Buffer;
  function copyProps(src, dst) {
    for (var key in src) {
      dst[key] = src[key];
    }
  }
  if (Buffer2.from && Buffer2.alloc && Buffer2.allocUnsafe && Buffer2.allocUnsafeSlow) {
    module.exports = buffer;
  } else {
    copyProps(buffer, exports);
    exports.Buffer = SafeBuffer;
  }
  function SafeBuffer(arg, encodingOrOffset, length) {
    return Buffer2(arg, encodingOrOffset, length);
  }
  SafeBuffer.prototype = Object.create(Buffer2.prototype);
  copyProps(Buffer2, SafeBuffer);
  SafeBuffer.from = function(arg, encodingOrOffset, length) {
    if (typeof arg === "number") {
      throw new TypeError("Argument must not be a number");
    }
    return Buffer2(arg, encodingOrOffset, length);
  };
  SafeBuffer.alloc = function(size, fill, encoding) {
    if (typeof size !== "number") {
      throw new TypeError("Argument must be a number");
    }
    var buf = Buffer2(size);
    if (fill !== undefined) {
      if (typeof encoding === "string") {
        buf.fill(fill, encoding);
      } else {
        buf.fill(fill);
      }
    } else {
      buf.fill(0);
    }
    return buf;
  };
  SafeBuffer.allocUnsafe = function(size) {
    if (typeof size !== "number") {
      throw new TypeError("Argument must be a number");
    }
    return Buffer2(size);
  };
  SafeBuffer.allocUnsafeSlow = function(size) {
    if (typeof size !== "number") {
      throw new TypeError("Argument must be a number");
    }
    return buffer.SlowBuffer(size);
  };
});

// ../../node_modules/string_decoder/lib/string_decoder.js
var require_string_decoder = __commonJS((exports) => {
  var Buffer2 = require_safe_buffer().Buffer;
  var isEncoding = Buffer2.isEncoding || function(encoding) {
    encoding = "" + encoding;
    switch (encoding && encoding.toLowerCase()) {
      case "hex":
      case "utf8":
      case "utf-8":
      case "ascii":
      case "binary":
      case "base64":
      case "ucs2":
      case "ucs-2":
      case "utf16le":
      case "utf-16le":
      case "raw":
        return true;
      default:
        return false;
    }
  };
  function _normalizeEncoding(enc) {
    if (!enc)
      return "utf8";
    var retried;
    while (true) {
      switch (enc) {
        case "utf8":
        case "utf-8":
          return "utf8";
        case "ucs2":
        case "ucs-2":
        case "utf16le":
        case "utf-16le":
          return "utf16le";
        case "latin1":
        case "binary":
          return "latin1";
        case "base64":
        case "ascii":
        case "hex":
          return enc;
        default:
          if (retried)
            return;
          enc = ("" + enc).toLowerCase();
          retried = true;
      }
    }
  }
  function normalizeEncoding(enc) {
    var nenc = _normalizeEncoding(enc);
    if (typeof nenc !== "string" && (Buffer2.isEncoding === isEncoding || !isEncoding(enc)))
      throw new Error("Unknown encoding: " + enc);
    return nenc || enc;
  }
  exports.StringDecoder = StringDecoder;
  function StringDecoder(encoding) {
    this.encoding = normalizeEncoding(encoding);
    var nb;
    switch (this.encoding) {
      case "utf16le":
        this.text = utf16Text;
        this.end = utf16End;
        nb = 4;
        break;
      case "utf8":
        this.fillLast = utf8FillLast;
        nb = 4;
        break;
      case "base64":
        this.text = base64Text;
        this.end = base64End;
        nb = 3;
        break;
      default:
        this.write = simpleWrite;
        this.end = simpleEnd;
        return;
    }
    this.lastNeed = 0;
    this.lastTotal = 0;
    this.lastChar = Buffer2.allocUnsafe(nb);
  }
  StringDecoder.prototype.write = function(buf) {
    if (buf.length === 0)
      return "";
    var r;
    var i;
    if (this.lastNeed) {
      r = this.fillLast(buf);
      if (r === undefined)
        return "";
      i = this.lastNeed;
      this.lastNeed = 0;
    } else {
      i = 0;
    }
    if (i < buf.length)
      return r ? r + this.text(buf, i) : this.text(buf, i);
    return r || "";
  };
  StringDecoder.prototype.end = utf8End;
  StringDecoder.prototype.text = utf8Text;
  StringDecoder.prototype.fillLast = function(buf) {
    if (this.lastNeed <= buf.length) {
      buf.copy(this.lastChar, this.lastTotal - this.lastNeed, 0, this.lastNeed);
      return this.lastChar.toString(this.encoding, 0, this.lastTotal);
    }
    buf.copy(this.lastChar, this.lastTotal - this.lastNeed, 0, buf.length);
    this.lastNeed -= buf.length;
  };
  function utf8CheckByte(byte) {
    if (byte <= 127)
      return 0;
    else if (byte >> 5 === 6)
      return 2;
    else if (byte >> 4 === 14)
      return 3;
    else if (byte >> 3 === 30)
      return 4;
    return byte >> 6 === 2 ? -1 : -2;
  }
  function utf8CheckIncomplete(self2, buf, i) {
    var j = buf.length - 1;
    if (j < i)
      return 0;
    var nb = utf8CheckByte(buf[j]);
    if (nb >= 0) {
      if (nb > 0)
        self2.lastNeed = nb - 1;
      return nb;
    }
    if (--j < i || nb === -2)
      return 0;
    nb = utf8CheckByte(buf[j]);
    if (nb >= 0) {
      if (nb > 0)
        self2.lastNeed = nb - 2;
      return nb;
    }
    if (--j < i || nb === -2)
      return 0;
    nb = utf8CheckByte(buf[j]);
    if (nb >= 0) {
      if (nb > 0) {
        if (nb === 2)
          nb = 0;
        else
          self2.lastNeed = nb - 3;
      }
      return nb;
    }
    return 0;
  }
  function utf8CheckExtraBytes(self2, buf, p) {
    if ((buf[0] & 192) !== 128) {
      self2.lastNeed = 0;
      return "\uFFFD";
    }
    if (self2.lastNeed > 1 && buf.length > 1) {
      if ((buf[1] & 192) !== 128) {
        self2.lastNeed = 1;
        return "\uFFFD";
      }
      if (self2.lastNeed > 2 && buf.length > 2) {
        if ((buf[2] & 192) !== 128) {
          self2.lastNeed = 2;
          return "\uFFFD";
        }
      }
    }
  }
  function utf8FillLast(buf) {
    var p = this.lastTotal - this.lastNeed;
    var r = utf8CheckExtraBytes(this, buf, p);
    if (r !== undefined)
      return r;
    if (this.lastNeed <= buf.length) {
      buf.copy(this.lastChar, p, 0, this.lastNeed);
      return this.lastChar.toString(this.encoding, 0, this.lastTotal);
    }
    buf.copy(this.lastChar, p, 0, buf.length);
    this.lastNeed -= buf.length;
  }
  function utf8Text(buf, i) {
    var total = utf8CheckIncomplete(this, buf, i);
    if (!this.lastNeed)
      return buf.toString("utf8", i);
    this.lastTotal = total;
    var end = buf.length - (total - this.lastNeed);
    buf.copy(this.lastChar, 0, end);
    return buf.toString("utf8", i, end);
  }
  function utf8End(buf) {
    var r = buf && buf.length ? this.write(buf) : "";
    if (this.lastNeed)
      return r + "\uFFFD";
    return r;
  }
  function utf16Text(buf, i) {
    if ((buf.length - i) % 2 === 0) {
      var r = buf.toString("utf16le", i);
      if (r) {
        var c = r.charCodeAt(r.length - 1);
        if (c >= 55296 && c <= 56319) {
          this.lastNeed = 2;
          this.lastTotal = 4;
          this.lastChar[0] = buf[buf.length - 2];
          this.lastChar[1] = buf[buf.length - 1];
          return r.slice(0, -1);
        }
      }
      return r;
    }
    this.lastNeed = 1;
    this.lastTotal = 2;
    this.lastChar[0] = buf[buf.length - 1];
    return buf.toString("utf16le", i, buf.length - 1);
  }
  function utf16End(buf) {
    var r = buf && buf.length ? this.write(buf) : "";
    if (this.lastNeed) {
      var end = this.lastTotal - this.lastNeed;
      return r + this.lastChar.toString("utf16le", 0, end);
    }
    return r;
  }
  function base64Text(buf, i) {
    var n = (buf.length - i) % 3;
    if (n === 0)
      return buf.toString("base64", i);
    this.lastNeed = 3 - n;
    this.lastTotal = 3;
    if (n === 1) {
      this.lastChar[0] = buf[buf.length - 1];
    } else {
      this.lastChar[0] = buf[buf.length - 2];
      this.lastChar[1] = buf[buf.length - 1];
    }
    return buf.toString("base64", i, buf.length - n);
  }
  function base64End(buf) {
    var r = buf && buf.length ? this.write(buf) : "";
    if (this.lastNeed)
      return r + this.lastChar.toString("base64", 0, 3 - this.lastNeed);
    return r;
  }
  function simpleWrite(buf) {
    return buf.toString(this.encoding);
  }
  function simpleEnd(buf) {
    return buf && buf.length ? this.write(buf) : "";
  }
});

// ../../node_modules/readable-stream/lib/internal/streams/end-of-stream.js
var require_end_of_stream = __commonJS((exports, module) => {
  var ERR_STREAM_PREMATURE_CLOSE = require_errors().codes.ERR_STREAM_PREMATURE_CLOSE;
  function once(callback) {
    var called = false;
    return function() {
      if (called)
        return;
      called = true;
      for (var _len = arguments.length, args = new Array(_len), _key = 0;_key < _len; _key++) {
        args[_key] = arguments[_key];
      }
      callback.apply(this, args);
    };
  }
  function noop() {}
  function isRequest(stream) {
    return stream.setHeader && typeof stream.abort === "function";
  }
  function eos(stream, opts, callback) {
    if (typeof opts === "function")
      return eos(stream, null, opts);
    if (!opts)
      opts = {};
    callback = once(callback || noop);
    var readable = opts.readable || opts.readable !== false && stream.readable;
    var writable = opts.writable || opts.writable !== false && stream.writable;
    var onlegacyfinish = function onlegacyfinish2() {
      if (!stream.writable)
        onfinish();
    };
    var writableEnded = stream._writableState && stream._writableState.finished;
    var onfinish = function onfinish2() {
      writable = false;
      writableEnded = true;
      if (!readable)
        callback.call(stream);
    };
    var readableEnded = stream._readableState && stream._readableState.endEmitted;
    var onend = function onend2() {
      readable = false;
      readableEnded = true;
      if (!writable)
        callback.call(stream);
    };
    var onerror = function onerror2(err) {
      callback.call(stream, err);
    };
    var onclose = function onclose2() {
      var err;
      if (readable && !readableEnded) {
        if (!stream._readableState || !stream._readableState.ended)
          err = new ERR_STREAM_PREMATURE_CLOSE;
        return callback.call(stream, err);
      }
      if (writable && !writableEnded) {
        if (!stream._writableState || !stream._writableState.ended)
          err = new ERR_STREAM_PREMATURE_CLOSE;
        return callback.call(stream, err);
      }
    };
    var onrequest = function onrequest2() {
      stream.req.on("finish", onfinish);
    };
    if (isRequest(stream)) {
      stream.on("complete", onfinish);
      stream.on("abort", onclose);
      if (stream.req)
        onrequest();
      else
        stream.on("request", onrequest);
    } else if (writable && !stream._writableState) {
      stream.on("end", onlegacyfinish);
      stream.on("close", onlegacyfinish);
    }
    stream.on("end", onend);
    stream.on("finish", onfinish);
    if (opts.error !== false)
      stream.on("error", onerror);
    stream.on("close", onclose);
    return function() {
      stream.removeListener("complete", onfinish);
      stream.removeListener("abort", onclose);
      stream.removeListener("request", onrequest);
      if (stream.req)
        stream.req.removeListener("finish", onfinish);
      stream.removeListener("end", onlegacyfinish);
      stream.removeListener("close", onlegacyfinish);
      stream.removeListener("finish", onfinish);
      stream.removeListener("end", onend);
      stream.removeListener("error", onerror);
      stream.removeListener("close", onclose);
    };
  }
  module.exports = eos;
});

// ../../node_modules/readable-stream/lib/internal/streams/async_iterator.js
var require_async_iterator = __commonJS((exports, module) => {
  var _Object$setPrototypeO;
  function _defineProperty(obj, key, value) {
    key = _toPropertyKey(key);
    if (key in obj) {
      Object.defineProperty(obj, key, { value, enumerable: true, configurable: true, writable: true });
    } else {
      obj[key] = value;
    }
    return obj;
  }
  function _toPropertyKey(arg) {
    var key = _toPrimitive(arg, "string");
    return typeof key === "symbol" ? key : String(key);
  }
  function _toPrimitive(input, hint) {
    if (typeof input !== "object" || input === null)
      return input;
    var prim = input[Symbol.toPrimitive];
    if (prim !== undefined) {
      var res = prim.call(input, hint || "default");
      if (typeof res !== "object")
        return res;
      throw new TypeError("@@toPrimitive must return a primitive value.");
    }
    return (hint === "string" ? String : Number)(input);
  }
  var finished = require_end_of_stream();
  var kLastResolve = Symbol("lastResolve");
  var kLastReject = Symbol("lastReject");
  var kError = Symbol("error");
  var kEnded = Symbol("ended");
  var kLastPromise = Symbol("lastPromise");
  var kHandlePromise = Symbol("handlePromise");
  var kStream = Symbol("stream");
  function createIterResult(value, done) {
    return {
      value,
      done
    };
  }
  function readAndResolve(iter) {
    var resolve = iter[kLastResolve];
    if (resolve !== null) {
      var data = iter[kStream].read();
      if (data !== null) {
        iter[kLastPromise] = null;
        iter[kLastResolve] = null;
        iter[kLastReject] = null;
        resolve(createIterResult(data, false));
      }
    }
  }
  function onReadable(iter) {
    process.nextTick(readAndResolve, iter);
  }
  function wrapForNext(lastPromise, iter) {
    return function(resolve, reject) {
      lastPromise.then(function() {
        if (iter[kEnded]) {
          resolve(createIterResult(undefined, true));
          return;
        }
        iter[kHandlePromise](resolve, reject);
      }, reject);
    };
  }
  var AsyncIteratorPrototype = Object.getPrototypeOf(function() {});
  var ReadableStreamAsyncIteratorPrototype = Object.setPrototypeOf((_Object$setPrototypeO = {
    get stream() {
      return this[kStream];
    },
    next: function next() {
      var _this = this;
      var error = this[kError];
      if (error !== null) {
        return Promise.reject(error);
      }
      if (this[kEnded]) {
        return Promise.resolve(createIterResult(undefined, true));
      }
      if (this[kStream].destroyed) {
        return new Promise(function(resolve, reject) {
          process.nextTick(function() {
            if (_this[kError]) {
              reject(_this[kError]);
            } else {
              resolve(createIterResult(undefined, true));
            }
          });
        });
      }
      var lastPromise = this[kLastPromise];
      var promise;
      if (lastPromise) {
        promise = new Promise(wrapForNext(lastPromise, this));
      } else {
        var data = this[kStream].read();
        if (data !== null) {
          return Promise.resolve(createIterResult(data, false));
        }
        promise = new Promise(this[kHandlePromise]);
      }
      this[kLastPromise] = promise;
      return promise;
    }
  }, _defineProperty(_Object$setPrototypeO, Symbol.asyncIterator, function() {
    return this;
  }), _defineProperty(_Object$setPrototypeO, "return", function _return() {
    var _this2 = this;
    return new Promise(function(resolve, reject) {
      _this2[kStream].destroy(null, function(err) {
        if (err) {
          reject(err);
          return;
        }
        resolve(createIterResult(undefined, true));
      });
    });
  }), _Object$setPrototypeO), AsyncIteratorPrototype);
  var createReadableStreamAsyncIterator = function createReadableStreamAsyncIterator2(stream) {
    var _Object$create;
    var iterator = Object.create(ReadableStreamAsyncIteratorPrototype, (_Object$create = {}, _defineProperty(_Object$create, kStream, {
      value: stream,
      writable: true
    }), _defineProperty(_Object$create, kLastResolve, {
      value: null,
      writable: true
    }), _defineProperty(_Object$create, kLastReject, {
      value: null,
      writable: true
    }), _defineProperty(_Object$create, kError, {
      value: null,
      writable: true
    }), _defineProperty(_Object$create, kEnded, {
      value: stream._readableState.endEmitted,
      writable: true
    }), _defineProperty(_Object$create, kHandlePromise, {
      value: function value(resolve, reject) {
        var data = iterator[kStream].read();
        if (data) {
          iterator[kLastPromise] = null;
          iterator[kLastResolve] = null;
          iterator[kLastReject] = null;
          resolve(createIterResult(data, false));
        } else {
          iterator[kLastResolve] = resolve;
          iterator[kLastReject] = reject;
        }
      },
      writable: true
    }), _Object$create));
    iterator[kLastPromise] = null;
    finished(stream, function(err) {
      if (err && err.code !== "ERR_STREAM_PREMATURE_CLOSE") {
        var reject = iterator[kLastReject];
        if (reject !== null) {
          iterator[kLastPromise] = null;
          iterator[kLastResolve] = null;
          iterator[kLastReject] = null;
          reject(err);
        }
        iterator[kError] = err;
        return;
      }
      var resolve = iterator[kLastResolve];
      if (resolve !== null) {
        iterator[kLastPromise] = null;
        iterator[kLastResolve] = null;
        iterator[kLastReject] = null;
        resolve(createIterResult(undefined, true));
      }
      iterator[kEnded] = true;
    });
    stream.on("readable", onReadable.bind(null, iterator));
    return iterator;
  };
  module.exports = createReadableStreamAsyncIterator;
});

// ../../node_modules/readable-stream/lib/internal/streams/from.js
var require_from = __commonJS((exports, module) => {
  function asyncGeneratorStep(gen, resolve, reject, _next, _throw, key, arg) {
    try {
      var info = gen[key](arg);
      var value = info.value;
    } catch (error) {
      reject(error);
      return;
    }
    if (info.done) {
      resolve(value);
    } else {
      Promise.resolve(value).then(_next, _throw);
    }
  }
  function _asyncToGenerator(fn) {
    return function() {
      var self2 = this, args = arguments;
      return new Promise(function(resolve, reject) {
        var gen = fn.apply(self2, args);
        function _next(value) {
          asyncGeneratorStep(gen, resolve, reject, _next, _throw, "next", value);
        }
        function _throw(err) {
          asyncGeneratorStep(gen, resolve, reject, _next, _throw, "throw", err);
        }
        _next(undefined);
      });
    };
  }
  function ownKeys(object, enumerableOnly) {
    var keys = Object.keys(object);
    if (Object.getOwnPropertySymbols) {
      var symbols = Object.getOwnPropertySymbols(object);
      enumerableOnly && (symbols = symbols.filter(function(sym) {
        return Object.getOwnPropertyDescriptor(object, sym).enumerable;
      })), keys.push.apply(keys, symbols);
    }
    return keys;
  }
  function _objectSpread(target) {
    for (var i = 1;i < arguments.length; i++) {
      var source = arguments[i] != null ? arguments[i] : {};
      i % 2 ? ownKeys(Object(source), true).forEach(function(key) {
        _defineProperty(target, key, source[key]);
      }) : Object.getOwnPropertyDescriptors ? Object.defineProperties(target, Object.getOwnPropertyDescriptors(source)) : ownKeys(Object(source)).forEach(function(key) {
        Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(source, key));
      });
    }
    return target;
  }
  function _defineProperty(obj, key, value) {
    key = _toPropertyKey(key);
    if (key in obj) {
      Object.defineProperty(obj, key, { value, enumerable: true, configurable: true, writable: true });
    } else {
      obj[key] = value;
    }
    return obj;
  }
  function _toPropertyKey(arg) {
    var key = _toPrimitive(arg, "string");
    return typeof key === "symbol" ? key : String(key);
  }
  function _toPrimitive(input, hint) {
    if (typeof input !== "object" || input === null)
      return input;
    var prim = input[Symbol.toPrimitive];
    if (prim !== undefined) {
      var res = prim.call(input, hint || "default");
      if (typeof res !== "object")
        return res;
      throw new TypeError("@@toPrimitive must return a primitive value.");
    }
    return (hint === "string" ? String : Number)(input);
  }
  var ERR_INVALID_ARG_TYPE = require_errors().codes.ERR_INVALID_ARG_TYPE;
  function from(Readable, iterable, opts) {
    var iterator;
    if (iterable && typeof iterable.next === "function") {
      iterator = iterable;
    } else if (iterable && iterable[Symbol.asyncIterator])
      iterator = iterable[Symbol.asyncIterator]();
    else if (iterable && iterable[Symbol.iterator])
      iterator = iterable[Symbol.iterator]();
    else
      throw new ERR_INVALID_ARG_TYPE("iterable", ["Iterable"], iterable);
    var readable = new Readable(_objectSpread({
      objectMode: true
    }, opts));
    var reading = false;
    readable._read = function() {
      if (!reading) {
        reading = true;
        next();
      }
    };
    function next() {
      return _next2.apply(this, arguments);
    }
    function _next2() {
      _next2 = _asyncToGenerator(function* () {
        try {
          var _yield$iterator$next = yield iterator.next(), value = _yield$iterator$next.value, done = _yield$iterator$next.done;
          if (done) {
            readable.push(null);
          } else if (readable.push(yield value)) {
            next();
          } else {
            reading = false;
          }
        } catch (err) {
          readable.destroy(err);
        }
      });
      return _next2.apply(this, arguments);
    }
    return readable;
  }
  module.exports = from;
});

// ../../node_modules/readable-stream/lib/_stream_readable.js
var require__stream_readable = __commonJS((exports, module) => {
  module.exports = Readable;
  var Duplex;
  Readable.ReadableState = ReadableState;
  var EE = __require("events").EventEmitter;
  var EElistenerCount = function EElistenerCount2(emitter, type) {
    return emitter.listeners(type).length;
  };
  var Stream = __require("stream");
  var Buffer2 = __require("buffer").Buffer;
  var OurUint8Array = (typeof global !== "undefined" ? global : typeof window !== "undefined" ? window : typeof self !== "undefined" ? self : {}).Uint8Array || function() {};
  function _uint8ArrayToBuffer(chunk) {
    return Buffer2.from(chunk);
  }
  function _isUint8Array(obj) {
    return Buffer2.isBuffer(obj) || obj instanceof OurUint8Array;
  }
  var debugUtil = __require("util");
  var debug;
  if (debugUtil && debugUtil.debuglog) {
    debug = debugUtil.debuglog("stream");
  } else {
    debug = function debug2() {};
  }
  var BufferList = require_buffer_list();
  var destroyImpl = require_destroy();
  var _require = require_state();
  var getHighWaterMark = _require.getHighWaterMark;
  var _require$codes = require_errors().codes;
  var ERR_INVALID_ARG_TYPE = _require$codes.ERR_INVALID_ARG_TYPE;
  var ERR_STREAM_PUSH_AFTER_EOF = _require$codes.ERR_STREAM_PUSH_AFTER_EOF;
  var ERR_METHOD_NOT_IMPLEMENTED = _require$codes.ERR_METHOD_NOT_IMPLEMENTED;
  var ERR_STREAM_UNSHIFT_AFTER_END_EVENT = _require$codes.ERR_STREAM_UNSHIFT_AFTER_END_EVENT;
  var StringDecoder;
  var createReadableStreamAsyncIterator;
  var from;
  require_inherits()(Readable, Stream);
  var errorOrDestroy = destroyImpl.errorOrDestroy;
  var kProxyEvents = ["error", "close", "destroy", "pause", "resume"];
  function prependListener(emitter, event, fn) {
    if (typeof emitter.prependListener === "function")
      return emitter.prependListener(event, fn);
    if (!emitter._events || !emitter._events[event])
      emitter.on(event, fn);
    else if (Array.isArray(emitter._events[event]))
      emitter._events[event].unshift(fn);
    else
      emitter._events[event] = [fn, emitter._events[event]];
  }
  function ReadableState(options, stream, isDuplex) {
    Duplex = Duplex || require__stream_duplex();
    options = options || {};
    if (typeof isDuplex !== "boolean")
      isDuplex = stream instanceof Duplex;
    this.objectMode = !!options.objectMode;
    if (isDuplex)
      this.objectMode = this.objectMode || !!options.readableObjectMode;
    this.highWaterMark = getHighWaterMark(this, options, "readableHighWaterMark", isDuplex);
    this.buffer = new BufferList;
    this.length = 0;
    this.pipes = null;
    this.pipesCount = 0;
    this.flowing = null;
    this.ended = false;
    this.endEmitted = false;
    this.reading = false;
    this.sync = true;
    this.needReadable = false;
    this.emittedReadable = false;
    this.readableListening = false;
    this.resumeScheduled = false;
    this.paused = true;
    this.emitClose = options.emitClose !== false;
    this.autoDestroy = !!options.autoDestroy;
    this.destroyed = false;
    this.defaultEncoding = options.defaultEncoding || "utf8";
    this.awaitDrain = 0;
    this.readingMore = false;
    this.decoder = null;
    this.encoding = null;
    if (options.encoding) {
      if (!StringDecoder)
        StringDecoder = require_string_decoder().StringDecoder;
      this.decoder = new StringDecoder(options.encoding);
      this.encoding = options.encoding;
    }
  }
  function Readable(options) {
    Duplex = Duplex || require__stream_duplex();
    if (!(this instanceof Readable))
      return new Readable(options);
    var isDuplex = this instanceof Duplex;
    this._readableState = new ReadableState(options, this, isDuplex);
    this.readable = true;
    if (options) {
      if (typeof options.read === "function")
        this._read = options.read;
      if (typeof options.destroy === "function")
        this._destroy = options.destroy;
    }
    Stream.call(this);
  }
  Object.defineProperty(Readable.prototype, "destroyed", {
    enumerable: false,
    get: function get() {
      if (this._readableState === undefined) {
        return false;
      }
      return this._readableState.destroyed;
    },
    set: function set(value) {
      if (!this._readableState) {
        return;
      }
      this._readableState.destroyed = value;
    }
  });
  Readable.prototype.destroy = destroyImpl.destroy;
  Readable.prototype._undestroy = destroyImpl.undestroy;
  Readable.prototype._destroy = function(err, cb) {
    cb(err);
  };
  Readable.prototype.push = function(chunk, encoding) {
    var state = this._readableState;
    var skipChunkCheck;
    if (!state.objectMode) {
      if (typeof chunk === "string") {
        encoding = encoding || state.defaultEncoding;
        if (encoding !== state.encoding) {
          chunk = Buffer2.from(chunk, encoding);
          encoding = "";
        }
        skipChunkCheck = true;
      }
    } else {
      skipChunkCheck = true;
    }
    return readableAddChunk(this, chunk, encoding, false, skipChunkCheck);
  };
  Readable.prototype.unshift = function(chunk) {
    return readableAddChunk(this, chunk, null, true, false);
  };
  function readableAddChunk(stream, chunk, encoding, addToFront, skipChunkCheck) {
    debug("readableAddChunk", chunk);
    var state = stream._readableState;
    if (chunk === null) {
      state.reading = false;
      onEofChunk(stream, state);
    } else {
      var er;
      if (!skipChunkCheck)
        er = chunkInvalid(state, chunk);
      if (er) {
        errorOrDestroy(stream, er);
      } else if (state.objectMode || chunk && chunk.length > 0) {
        if (typeof chunk !== "string" && !state.objectMode && Object.getPrototypeOf(chunk) !== Buffer2.prototype) {
          chunk = _uint8ArrayToBuffer(chunk);
        }
        if (addToFront) {
          if (state.endEmitted)
            errorOrDestroy(stream, new ERR_STREAM_UNSHIFT_AFTER_END_EVENT);
          else
            addChunk(stream, state, chunk, true);
        } else if (state.ended) {
          errorOrDestroy(stream, new ERR_STREAM_PUSH_AFTER_EOF);
        } else if (state.destroyed) {
          return false;
        } else {
          state.reading = false;
          if (state.decoder && !encoding) {
            chunk = state.decoder.write(chunk);
            if (state.objectMode || chunk.length !== 0)
              addChunk(stream, state, chunk, false);
            else
              maybeReadMore(stream, state);
          } else {
            addChunk(stream, state, chunk, false);
          }
        }
      } else if (!addToFront) {
        state.reading = false;
        maybeReadMore(stream, state);
      }
    }
    return !state.ended && (state.length < state.highWaterMark || state.length === 0);
  }
  function addChunk(stream, state, chunk, addToFront) {
    if (state.flowing && state.length === 0 && !state.sync) {
      state.awaitDrain = 0;
      stream.emit("data", chunk);
    } else {
      state.length += state.objectMode ? 1 : chunk.length;
      if (addToFront)
        state.buffer.unshift(chunk);
      else
        state.buffer.push(chunk);
      if (state.needReadable)
        emitReadable(stream);
    }
    maybeReadMore(stream, state);
  }
  function chunkInvalid(state, chunk) {
    var er;
    if (!_isUint8Array(chunk) && typeof chunk !== "string" && chunk !== undefined && !state.objectMode) {
      er = new ERR_INVALID_ARG_TYPE("chunk", ["string", "Buffer", "Uint8Array"], chunk);
    }
    return er;
  }
  Readable.prototype.isPaused = function() {
    return this._readableState.flowing === false;
  };
  Readable.prototype.setEncoding = function(enc) {
    if (!StringDecoder)
      StringDecoder = require_string_decoder().StringDecoder;
    var decoder = new StringDecoder(enc);
    this._readableState.decoder = decoder;
    this._readableState.encoding = this._readableState.decoder.encoding;
    var p = this._readableState.buffer.head;
    var content = "";
    while (p !== null) {
      content += decoder.write(p.data);
      p = p.next;
    }
    this._readableState.buffer.clear();
    if (content !== "")
      this._readableState.buffer.push(content);
    this._readableState.length = content.length;
    return this;
  };
  var MAX_HWM = 1073741824;
  function computeNewHighWaterMark(n) {
    if (n >= MAX_HWM) {
      n = MAX_HWM;
    } else {
      n--;
      n |= n >>> 1;
      n |= n >>> 2;
      n |= n >>> 4;
      n |= n >>> 8;
      n |= n >>> 16;
      n++;
    }
    return n;
  }
  function howMuchToRead(n, state) {
    if (n <= 0 || state.length === 0 && state.ended)
      return 0;
    if (state.objectMode)
      return 1;
    if (n !== n) {
      if (state.flowing && state.length)
        return state.buffer.head.data.length;
      else
        return state.length;
    }
    if (n > state.highWaterMark)
      state.highWaterMark = computeNewHighWaterMark(n);
    if (n <= state.length)
      return n;
    if (!state.ended) {
      state.needReadable = true;
      return 0;
    }
    return state.length;
  }
  Readable.prototype.read = function(n) {
    debug("read", n);
    n = parseInt(n, 10);
    var state = this._readableState;
    var nOrig = n;
    if (n !== 0)
      state.emittedReadable = false;
    if (n === 0 && state.needReadable && ((state.highWaterMark !== 0 ? state.length >= state.highWaterMark : state.length > 0) || state.ended)) {
      debug("read: emitReadable", state.length, state.ended);
      if (state.length === 0 && state.ended)
        endReadable(this);
      else
        emitReadable(this);
      return null;
    }
    n = howMuchToRead(n, state);
    if (n === 0 && state.ended) {
      if (state.length === 0)
        endReadable(this);
      return null;
    }
    var doRead = state.needReadable;
    debug("need readable", doRead);
    if (state.length === 0 || state.length - n < state.highWaterMark) {
      doRead = true;
      debug("length less than watermark", doRead);
    }
    if (state.ended || state.reading) {
      doRead = false;
      debug("reading or ended", doRead);
    } else if (doRead) {
      debug("do read");
      state.reading = true;
      state.sync = true;
      if (state.length === 0)
        state.needReadable = true;
      this._read(state.highWaterMark);
      state.sync = false;
      if (!state.reading)
        n = howMuchToRead(nOrig, state);
    }
    var ret;
    if (n > 0)
      ret = fromList(n, state);
    else
      ret = null;
    if (ret === null) {
      state.needReadable = state.length <= state.highWaterMark;
      n = 0;
    } else {
      state.length -= n;
      state.awaitDrain = 0;
    }
    if (state.length === 0) {
      if (!state.ended)
        state.needReadable = true;
      if (nOrig !== n && state.ended)
        endReadable(this);
    }
    if (ret !== null)
      this.emit("data", ret);
    return ret;
  };
  function onEofChunk(stream, state) {
    debug("onEofChunk");
    if (state.ended)
      return;
    if (state.decoder) {
      var chunk = state.decoder.end();
      if (chunk && chunk.length) {
        state.buffer.push(chunk);
        state.length += state.objectMode ? 1 : chunk.length;
      }
    }
    state.ended = true;
    if (state.sync) {
      emitReadable(stream);
    } else {
      state.needReadable = false;
      if (!state.emittedReadable) {
        state.emittedReadable = true;
        emitReadable_(stream);
      }
    }
  }
  function emitReadable(stream) {
    var state = stream._readableState;
    debug("emitReadable", state.needReadable, state.emittedReadable);
    state.needReadable = false;
    if (!state.emittedReadable) {
      debug("emitReadable", state.flowing);
      state.emittedReadable = true;
      process.nextTick(emitReadable_, stream);
    }
  }
  function emitReadable_(stream) {
    var state = stream._readableState;
    debug("emitReadable_", state.destroyed, state.length, state.ended);
    if (!state.destroyed && (state.length || state.ended)) {
      stream.emit("readable");
      state.emittedReadable = false;
    }
    state.needReadable = !state.flowing && !state.ended && state.length <= state.highWaterMark;
    flow(stream);
  }
  function maybeReadMore(stream, state) {
    if (!state.readingMore) {
      state.readingMore = true;
      process.nextTick(maybeReadMore_, stream, state);
    }
  }
  function maybeReadMore_(stream, state) {
    while (!state.reading && !state.ended && (state.length < state.highWaterMark || state.flowing && state.length === 0)) {
      var len = state.length;
      debug("maybeReadMore read 0");
      stream.read(0);
      if (len === state.length)
        break;
    }
    state.readingMore = false;
  }
  Readable.prototype._read = function(n) {
    errorOrDestroy(this, new ERR_METHOD_NOT_IMPLEMENTED("_read()"));
  };
  Readable.prototype.pipe = function(dest, pipeOpts) {
    var src = this;
    var state = this._readableState;
    switch (state.pipesCount) {
      case 0:
        state.pipes = dest;
        break;
      case 1:
        state.pipes = [state.pipes, dest];
        break;
      default:
        state.pipes.push(dest);
        break;
    }
    state.pipesCount += 1;
    debug("pipe count=%d opts=%j", state.pipesCount, pipeOpts);
    var doEnd = (!pipeOpts || pipeOpts.end !== false) && dest !== process.stdout && dest !== process.stderr;
    var endFn = doEnd ? onend : unpipe;
    if (state.endEmitted)
      process.nextTick(endFn);
    else
      src.once("end", endFn);
    dest.on("unpipe", onunpipe);
    function onunpipe(readable, unpipeInfo) {
      debug("onunpipe");
      if (readable === src) {
        if (unpipeInfo && unpipeInfo.hasUnpiped === false) {
          unpipeInfo.hasUnpiped = true;
          cleanup();
        }
      }
    }
    function onend() {
      debug("onend");
      dest.end();
    }
    var ondrain = pipeOnDrain(src);
    dest.on("drain", ondrain);
    var cleanedUp = false;
    function cleanup() {
      debug("cleanup");
      dest.removeListener("close", onclose);
      dest.removeListener("finish", onfinish);
      dest.removeListener("drain", ondrain);
      dest.removeListener("error", onerror);
      dest.removeListener("unpipe", onunpipe);
      src.removeListener("end", onend);
      src.removeListener("end", unpipe);
      src.removeListener("data", ondata);
      cleanedUp = true;
      if (state.awaitDrain && (!dest._writableState || dest._writableState.needDrain))
        ondrain();
    }
    src.on("data", ondata);
    function ondata(chunk) {
      debug("ondata");
      var ret = dest.write(chunk);
      debug("dest.write", ret);
      if (ret === false) {
        if ((state.pipesCount === 1 && state.pipes === dest || state.pipesCount > 1 && indexOf(state.pipes, dest) !== -1) && !cleanedUp) {
          debug("false write response, pause", state.awaitDrain);
          state.awaitDrain++;
        }
        src.pause();
      }
    }
    function onerror(er) {
      debug("onerror", er);
      unpipe();
      dest.removeListener("error", onerror);
      if (EElistenerCount(dest, "error") === 0)
        errorOrDestroy(dest, er);
    }
    prependListener(dest, "error", onerror);
    function onclose() {
      dest.removeListener("finish", onfinish);
      unpipe();
    }
    dest.once("close", onclose);
    function onfinish() {
      debug("onfinish");
      dest.removeListener("close", onclose);
      unpipe();
    }
    dest.once("finish", onfinish);
    function unpipe() {
      debug("unpipe");
      src.unpipe(dest);
    }
    dest.emit("pipe", src);
    if (!state.flowing) {
      debug("pipe resume");
      src.resume();
    }
    return dest;
  };
  function pipeOnDrain(src) {
    return function pipeOnDrainFunctionResult() {
      var state = src._readableState;
      debug("pipeOnDrain", state.awaitDrain);
      if (state.awaitDrain)
        state.awaitDrain--;
      if (state.awaitDrain === 0 && EElistenerCount(src, "data")) {
        state.flowing = true;
        flow(src);
      }
    };
  }
  Readable.prototype.unpipe = function(dest) {
    var state = this._readableState;
    var unpipeInfo = {
      hasUnpiped: false
    };
    if (state.pipesCount === 0)
      return this;
    if (state.pipesCount === 1) {
      if (dest && dest !== state.pipes)
        return this;
      if (!dest)
        dest = state.pipes;
      state.pipes = null;
      state.pipesCount = 0;
      state.flowing = false;
      if (dest)
        dest.emit("unpipe", this, unpipeInfo);
      return this;
    }
    if (!dest) {
      var dests = state.pipes;
      var len = state.pipesCount;
      state.pipes = null;
      state.pipesCount = 0;
      state.flowing = false;
      for (var i = 0;i < len; i++)
        dests[i].emit("unpipe", this, {
          hasUnpiped: false
        });
      return this;
    }
    var index = indexOf(state.pipes, dest);
    if (index === -1)
      return this;
    state.pipes.splice(index, 1);
    state.pipesCount -= 1;
    if (state.pipesCount === 1)
      state.pipes = state.pipes[0];
    dest.emit("unpipe", this, unpipeInfo);
    return this;
  };
  Readable.prototype.on = function(ev, fn) {
    var res = Stream.prototype.on.call(this, ev, fn);
    var state = this._readableState;
    if (ev === "data") {
      state.readableListening = this.listenerCount("readable") > 0;
      if (state.flowing !== false)
        this.resume();
    } else if (ev === "readable") {
      if (!state.endEmitted && !state.readableListening) {
        state.readableListening = state.needReadable = true;
        state.flowing = false;
        state.emittedReadable = false;
        debug("on readable", state.length, state.reading);
        if (state.length) {
          emitReadable(this);
        } else if (!state.reading) {
          process.nextTick(nReadingNextTick, this);
        }
      }
    }
    return res;
  };
  Readable.prototype.addListener = Readable.prototype.on;
  Readable.prototype.removeListener = function(ev, fn) {
    var res = Stream.prototype.removeListener.call(this, ev, fn);
    if (ev === "readable") {
      process.nextTick(updateReadableListening, this);
    }
    return res;
  };
  Readable.prototype.removeAllListeners = function(ev) {
    var res = Stream.prototype.removeAllListeners.apply(this, arguments);
    if (ev === "readable" || ev === undefined) {
      process.nextTick(updateReadableListening, this);
    }
    return res;
  };
  function updateReadableListening(self2) {
    var state = self2._readableState;
    state.readableListening = self2.listenerCount("readable") > 0;
    if (state.resumeScheduled && !state.paused) {
      state.flowing = true;
    } else if (self2.listenerCount("data") > 0) {
      self2.resume();
    }
  }
  function nReadingNextTick(self2) {
    debug("readable nexttick read 0");
    self2.read(0);
  }
  Readable.prototype.resume = function() {
    var state = this._readableState;
    if (!state.flowing) {
      debug("resume");
      state.flowing = !state.readableListening;
      resume(this, state);
    }
    state.paused = false;
    return this;
  };
  function resume(stream, state) {
    if (!state.resumeScheduled) {
      state.resumeScheduled = true;
      process.nextTick(resume_, stream, state);
    }
  }
  function resume_(stream, state) {
    debug("resume", state.reading);
    if (!state.reading) {
      stream.read(0);
    }
    state.resumeScheduled = false;
    stream.emit("resume");
    flow(stream);
    if (state.flowing && !state.reading)
      stream.read(0);
  }
  Readable.prototype.pause = function() {
    debug("call pause flowing=%j", this._readableState.flowing);
    if (this._readableState.flowing !== false) {
      debug("pause");
      this._readableState.flowing = false;
      this.emit("pause");
    }
    this._readableState.paused = true;
    return this;
  };
  function flow(stream) {
    var state = stream._readableState;
    debug("flow", state.flowing);
    while (state.flowing && stream.read() !== null)
      ;
  }
  Readable.prototype.wrap = function(stream) {
    var _this = this;
    var state = this._readableState;
    var paused = false;
    stream.on("end", function() {
      debug("wrapped end");
      if (state.decoder && !state.ended) {
        var chunk = state.decoder.end();
        if (chunk && chunk.length)
          _this.push(chunk);
      }
      _this.push(null);
    });
    stream.on("data", function(chunk) {
      debug("wrapped data");
      if (state.decoder)
        chunk = state.decoder.write(chunk);
      if (state.objectMode && (chunk === null || chunk === undefined))
        return;
      else if (!state.objectMode && (!chunk || !chunk.length))
        return;
      var ret = _this.push(chunk);
      if (!ret) {
        paused = true;
        stream.pause();
      }
    });
    for (var i in stream) {
      if (this[i] === undefined && typeof stream[i] === "function") {
        this[i] = function methodWrap(method) {
          return function methodWrapReturnFunction() {
            return stream[method].apply(stream, arguments);
          };
        }(i);
      }
    }
    for (var n = 0;n < kProxyEvents.length; n++) {
      stream.on(kProxyEvents[n], this.emit.bind(this, kProxyEvents[n]));
    }
    this._read = function(n2) {
      debug("wrapped _read", n2);
      if (paused) {
        paused = false;
        stream.resume();
      }
    };
    return this;
  };
  if (typeof Symbol === "function") {
    Readable.prototype[Symbol.asyncIterator] = function() {
      if (createReadableStreamAsyncIterator === undefined) {
        createReadableStreamAsyncIterator = require_async_iterator();
      }
      return createReadableStreamAsyncIterator(this);
    };
  }
  Object.defineProperty(Readable.prototype, "readableHighWaterMark", {
    enumerable: false,
    get: function get() {
      return this._readableState.highWaterMark;
    }
  });
  Object.defineProperty(Readable.prototype, "readableBuffer", {
    enumerable: false,
    get: function get() {
      return this._readableState && this._readableState.buffer;
    }
  });
  Object.defineProperty(Readable.prototype, "readableFlowing", {
    enumerable: false,
    get: function get() {
      return this._readableState.flowing;
    },
    set: function set(state) {
      if (this._readableState) {
        this._readableState.flowing = state;
      }
    }
  });
  Readable._fromList = fromList;
  Object.defineProperty(Readable.prototype, "readableLength", {
    enumerable: false,
    get: function get() {
      return this._readableState.length;
    }
  });
  function fromList(n, state) {
    if (state.length === 0)
      return null;
    var ret;
    if (state.objectMode)
      ret = state.buffer.shift();
    else if (!n || n >= state.length) {
      if (state.decoder)
        ret = state.buffer.join("");
      else if (state.buffer.length === 1)
        ret = state.buffer.first();
      else
        ret = state.buffer.concat(state.length);
      state.buffer.clear();
    } else {
      ret = state.buffer.consume(n, state.decoder);
    }
    return ret;
  }
  function endReadable(stream) {
    var state = stream._readableState;
    debug("endReadable", state.endEmitted);
    if (!state.endEmitted) {
      state.ended = true;
      process.nextTick(endReadableNT, state, stream);
    }
  }
  function endReadableNT(state, stream) {
    debug("endReadableNT", state.endEmitted, state.length);
    if (!state.endEmitted && state.length === 0) {
      state.endEmitted = true;
      stream.readable = false;
      stream.emit("end");
      if (state.autoDestroy) {
        var wState = stream._writableState;
        if (!wState || wState.autoDestroy && wState.finished) {
          stream.destroy();
        }
      }
    }
  }
  if (typeof Symbol === "function") {
    Readable.from = function(iterable, opts) {
      if (from === undefined) {
        from = require_from();
      }
      return from(Readable, iterable, opts);
    };
  }
  function indexOf(xs, x) {
    for (var i = 0, l = xs.length;i < l; i++) {
      if (xs[i] === x)
        return i;
    }
    return -1;
  }
});

// ../../node_modules/readable-stream/lib/_stream_duplex.js
var require__stream_duplex = __commonJS((exports, module) => {
  var objectKeys = Object.keys || function(obj) {
    var keys2 = [];
    for (var key in obj)
      keys2.push(key);
    return keys2;
  };
  module.exports = Duplex;
  var Readable = require__stream_readable();
  var Writable = require__stream_writable();
  require_inherits()(Duplex, Readable);
  {
    keys = objectKeys(Writable.prototype);
    for (v = 0;v < keys.length; v++) {
      method = keys[v];
      if (!Duplex.prototype[method])
        Duplex.prototype[method] = Writable.prototype[method];
    }
  }
  var keys;
  var method;
  var v;
  function Duplex(options) {
    if (!(this instanceof Duplex))
      return new Duplex(options);
    Readable.call(this, options);
    Writable.call(this, options);
    this.allowHalfOpen = true;
    if (options) {
      if (options.readable === false)
        this.readable = false;
      if (options.writable === false)
        this.writable = false;
      if (options.allowHalfOpen === false) {
        this.allowHalfOpen = false;
        this.once("end", onend);
      }
    }
  }
  Object.defineProperty(Duplex.prototype, "writableHighWaterMark", {
    enumerable: false,
    get: function get() {
      return this._writableState.highWaterMark;
    }
  });
  Object.defineProperty(Duplex.prototype, "writableBuffer", {
    enumerable: false,
    get: function get() {
      return this._writableState && this._writableState.getBuffer();
    }
  });
  Object.defineProperty(Duplex.prototype, "writableLength", {
    enumerable: false,
    get: function get() {
      return this._writableState.length;
    }
  });
  function onend() {
    if (this._writableState.ended)
      return;
    process.nextTick(onEndNT, this);
  }
  function onEndNT(self2) {
    self2.end();
  }
  Object.defineProperty(Duplex.prototype, "destroyed", {
    enumerable: false,
    get: function get() {
      if (this._readableState === undefined || this._writableState === undefined) {
        return false;
      }
      return this._readableState.destroyed && this._writableState.destroyed;
    },
    set: function set(value) {
      if (this._readableState === undefined || this._writableState === undefined) {
        return;
      }
      this._readableState.destroyed = value;
      this._writableState.destroyed = value;
    }
  });
});

// ../../node_modules/readable-stream/lib/_stream_writable.js
var require__stream_writable = __commonJS((exports, module) => {
  module.exports = Writable;
  function CorkedRequest(state) {
    var _this = this;
    this.next = null;
    this.entry = null;
    this.finish = function() {
      onCorkedFinish(_this, state);
    };
  }
  var Duplex;
  Writable.WritableState = WritableState;
  var internalUtil = {
    deprecate: require_node()
  };
  var Stream = __require("stream");
  var Buffer2 = __require("buffer").Buffer;
  var OurUint8Array = (typeof global !== "undefined" ? global : typeof window !== "undefined" ? window : typeof self !== "undefined" ? self : {}).Uint8Array || function() {};
  function _uint8ArrayToBuffer(chunk) {
    return Buffer2.from(chunk);
  }
  function _isUint8Array(obj) {
    return Buffer2.isBuffer(obj) || obj instanceof OurUint8Array;
  }
  var destroyImpl = require_destroy();
  var _require = require_state();
  var getHighWaterMark = _require.getHighWaterMark;
  var _require$codes = require_errors().codes;
  var ERR_INVALID_ARG_TYPE = _require$codes.ERR_INVALID_ARG_TYPE;
  var ERR_METHOD_NOT_IMPLEMENTED = _require$codes.ERR_METHOD_NOT_IMPLEMENTED;
  var ERR_MULTIPLE_CALLBACK = _require$codes.ERR_MULTIPLE_CALLBACK;
  var ERR_STREAM_CANNOT_PIPE = _require$codes.ERR_STREAM_CANNOT_PIPE;
  var ERR_STREAM_DESTROYED = _require$codes.ERR_STREAM_DESTROYED;
  var ERR_STREAM_NULL_VALUES = _require$codes.ERR_STREAM_NULL_VALUES;
  var ERR_STREAM_WRITE_AFTER_END = _require$codes.ERR_STREAM_WRITE_AFTER_END;
  var ERR_UNKNOWN_ENCODING = _require$codes.ERR_UNKNOWN_ENCODING;
  var errorOrDestroy = destroyImpl.errorOrDestroy;
  require_inherits()(Writable, Stream);
  function nop() {}
  function WritableState(options, stream, isDuplex) {
    Duplex = Duplex || require__stream_duplex();
    options = options || {};
    if (typeof isDuplex !== "boolean")
      isDuplex = stream instanceof Duplex;
    this.objectMode = !!options.objectMode;
    if (isDuplex)
      this.objectMode = this.objectMode || !!options.writableObjectMode;
    this.highWaterMark = getHighWaterMark(this, options, "writableHighWaterMark", isDuplex);
    this.finalCalled = false;
    this.needDrain = false;
    this.ending = false;
    this.ended = false;
    this.finished = false;
    this.destroyed = false;
    var noDecode = options.decodeStrings === false;
    this.decodeStrings = !noDecode;
    this.defaultEncoding = options.defaultEncoding || "utf8";
    this.length = 0;
    this.writing = false;
    this.corked = 0;
    this.sync = true;
    this.bufferProcessing = false;
    this.onwrite = function(er) {
      onwrite(stream, er);
    };
    this.writecb = null;
    this.writelen = 0;
    this.bufferedRequest = null;
    this.lastBufferedRequest = null;
    this.pendingcb = 0;
    this.prefinished = false;
    this.errorEmitted = false;
    this.emitClose = options.emitClose !== false;
    this.autoDestroy = !!options.autoDestroy;
    this.bufferedRequestCount = 0;
    this.corkedRequestsFree = new CorkedRequest(this);
  }
  WritableState.prototype.getBuffer = function getBuffer() {
    var current = this.bufferedRequest;
    var out = [];
    while (current) {
      out.push(current);
      current = current.next;
    }
    return out;
  };
  (function() {
    try {
      Object.defineProperty(WritableState.prototype, "buffer", {
        get: internalUtil.deprecate(function writableStateBufferGetter() {
          return this.getBuffer();
        }, "_writableState.buffer is deprecated. Use _writableState.getBuffer " + "instead.", "DEP0003")
      });
    } catch (_) {}
  })();
  var realHasInstance;
  if (typeof Symbol === "function" && Symbol.hasInstance && typeof Function.prototype[Symbol.hasInstance] === "function") {
    realHasInstance = Function.prototype[Symbol.hasInstance];
    Object.defineProperty(Writable, Symbol.hasInstance, {
      value: function value(object) {
        if (realHasInstance.call(this, object))
          return true;
        if (this !== Writable)
          return false;
        return object && object._writableState instanceof WritableState;
      }
    });
  } else {
    realHasInstance = function realHasInstance2(object) {
      return object instanceof this;
    };
  }
  function Writable(options) {
    Duplex = Duplex || require__stream_duplex();
    var isDuplex = this instanceof Duplex;
    if (!isDuplex && !realHasInstance.call(Writable, this))
      return new Writable(options);
    this._writableState = new WritableState(options, this, isDuplex);
    this.writable = true;
    if (options) {
      if (typeof options.write === "function")
        this._write = options.write;
      if (typeof options.writev === "function")
        this._writev = options.writev;
      if (typeof options.destroy === "function")
        this._destroy = options.destroy;
      if (typeof options.final === "function")
        this._final = options.final;
    }
    Stream.call(this);
  }
  Writable.prototype.pipe = function() {
    errorOrDestroy(this, new ERR_STREAM_CANNOT_PIPE);
  };
  function writeAfterEnd(stream, cb) {
    var er = new ERR_STREAM_WRITE_AFTER_END;
    errorOrDestroy(stream, er);
    process.nextTick(cb, er);
  }
  function validChunk(stream, state, chunk, cb) {
    var er;
    if (chunk === null) {
      er = new ERR_STREAM_NULL_VALUES;
    } else if (typeof chunk !== "string" && !state.objectMode) {
      er = new ERR_INVALID_ARG_TYPE("chunk", ["string", "Buffer"], chunk);
    }
    if (er) {
      errorOrDestroy(stream, er);
      process.nextTick(cb, er);
      return false;
    }
    return true;
  }
  Writable.prototype.write = function(chunk, encoding, cb) {
    var state = this._writableState;
    var ret = false;
    var isBuf = !state.objectMode && _isUint8Array(chunk);
    if (isBuf && !Buffer2.isBuffer(chunk)) {
      chunk = _uint8ArrayToBuffer(chunk);
    }
    if (typeof encoding === "function") {
      cb = encoding;
      encoding = null;
    }
    if (isBuf)
      encoding = "buffer";
    else if (!encoding)
      encoding = state.defaultEncoding;
    if (typeof cb !== "function")
      cb = nop;
    if (state.ending)
      writeAfterEnd(this, cb);
    else if (isBuf || validChunk(this, state, chunk, cb)) {
      state.pendingcb++;
      ret = writeOrBuffer(this, state, isBuf, chunk, encoding, cb);
    }
    return ret;
  };
  Writable.prototype.cork = function() {
    this._writableState.corked++;
  };
  Writable.prototype.uncork = function() {
    var state = this._writableState;
    if (state.corked) {
      state.corked--;
      if (!state.writing && !state.corked && !state.bufferProcessing && state.bufferedRequest)
        clearBuffer(this, state);
    }
  };
  Writable.prototype.setDefaultEncoding = function setDefaultEncoding(encoding) {
    if (typeof encoding === "string")
      encoding = encoding.toLowerCase();
    if (!(["hex", "utf8", "utf-8", "ascii", "binary", "base64", "ucs2", "ucs-2", "utf16le", "utf-16le", "raw"].indexOf((encoding + "").toLowerCase()) > -1))
      throw new ERR_UNKNOWN_ENCODING(encoding);
    this._writableState.defaultEncoding = encoding;
    return this;
  };
  Object.defineProperty(Writable.prototype, "writableBuffer", {
    enumerable: false,
    get: function get() {
      return this._writableState && this._writableState.getBuffer();
    }
  });
  function decodeChunk(state, chunk, encoding) {
    if (!state.objectMode && state.decodeStrings !== false && typeof chunk === "string") {
      chunk = Buffer2.from(chunk, encoding);
    }
    return chunk;
  }
  Object.defineProperty(Writable.prototype, "writableHighWaterMark", {
    enumerable: false,
    get: function get() {
      return this._writableState.highWaterMark;
    }
  });
  function writeOrBuffer(stream, state, isBuf, chunk, encoding, cb) {
    if (!isBuf) {
      var newChunk = decodeChunk(state, chunk, encoding);
      if (chunk !== newChunk) {
        isBuf = true;
        encoding = "buffer";
        chunk = newChunk;
      }
    }
    var len = state.objectMode ? 1 : chunk.length;
    state.length += len;
    var ret = state.length < state.highWaterMark;
    if (!ret)
      state.needDrain = true;
    if (state.writing || state.corked) {
      var last = state.lastBufferedRequest;
      state.lastBufferedRequest = {
        chunk,
        encoding,
        isBuf,
        callback: cb,
        next: null
      };
      if (last) {
        last.next = state.lastBufferedRequest;
      } else {
        state.bufferedRequest = state.lastBufferedRequest;
      }
      state.bufferedRequestCount += 1;
    } else {
      doWrite(stream, state, false, len, chunk, encoding, cb);
    }
    return ret;
  }
  function doWrite(stream, state, writev, len, chunk, encoding, cb) {
    state.writelen = len;
    state.writecb = cb;
    state.writing = true;
    state.sync = true;
    if (state.destroyed)
      state.onwrite(new ERR_STREAM_DESTROYED("write"));
    else if (writev)
      stream._writev(chunk, state.onwrite);
    else
      stream._write(chunk, encoding, state.onwrite);
    state.sync = false;
  }
  function onwriteError(stream, state, sync, er, cb) {
    --state.pendingcb;
    if (sync) {
      process.nextTick(cb, er);
      process.nextTick(finishMaybe, stream, state);
      stream._writableState.errorEmitted = true;
      errorOrDestroy(stream, er);
    } else {
      cb(er);
      stream._writableState.errorEmitted = true;
      errorOrDestroy(stream, er);
      finishMaybe(stream, state);
    }
  }
  function onwriteStateUpdate(state) {
    state.writing = false;
    state.writecb = null;
    state.length -= state.writelen;
    state.writelen = 0;
  }
  function onwrite(stream, er) {
    var state = stream._writableState;
    var sync = state.sync;
    var cb = state.writecb;
    if (typeof cb !== "function")
      throw new ERR_MULTIPLE_CALLBACK;
    onwriteStateUpdate(state);
    if (er)
      onwriteError(stream, state, sync, er, cb);
    else {
      var finished = needFinish(state) || stream.destroyed;
      if (!finished && !state.corked && !state.bufferProcessing && state.bufferedRequest) {
        clearBuffer(stream, state);
      }
      if (sync) {
        process.nextTick(afterWrite, stream, state, finished, cb);
      } else {
        afterWrite(stream, state, finished, cb);
      }
    }
  }
  function afterWrite(stream, state, finished, cb) {
    if (!finished)
      onwriteDrain(stream, state);
    state.pendingcb--;
    cb();
    finishMaybe(stream, state);
  }
  function onwriteDrain(stream, state) {
    if (state.length === 0 && state.needDrain) {
      state.needDrain = false;
      stream.emit("drain");
    }
  }
  function clearBuffer(stream, state) {
    state.bufferProcessing = true;
    var entry = state.bufferedRequest;
    if (stream._writev && entry && entry.next) {
      var l = state.bufferedRequestCount;
      var buffer = new Array(l);
      var holder = state.corkedRequestsFree;
      holder.entry = entry;
      var count = 0;
      var allBuffers = true;
      while (entry) {
        buffer[count] = entry;
        if (!entry.isBuf)
          allBuffers = false;
        entry = entry.next;
        count += 1;
      }
      buffer.allBuffers = allBuffers;
      doWrite(stream, state, true, state.length, buffer, "", holder.finish);
      state.pendingcb++;
      state.lastBufferedRequest = null;
      if (holder.next) {
        state.corkedRequestsFree = holder.next;
        holder.next = null;
      } else {
        state.corkedRequestsFree = new CorkedRequest(state);
      }
      state.bufferedRequestCount = 0;
    } else {
      while (entry) {
        var chunk = entry.chunk;
        var encoding = entry.encoding;
        var cb = entry.callback;
        var len = state.objectMode ? 1 : chunk.length;
        doWrite(stream, state, false, len, chunk, encoding, cb);
        entry = entry.next;
        state.bufferedRequestCount--;
        if (state.writing) {
          break;
        }
      }
      if (entry === null)
        state.lastBufferedRequest = null;
    }
    state.bufferedRequest = entry;
    state.bufferProcessing = false;
  }
  Writable.prototype._write = function(chunk, encoding, cb) {
    cb(new ERR_METHOD_NOT_IMPLEMENTED("_write()"));
  };
  Writable.prototype._writev = null;
  Writable.prototype.end = function(chunk, encoding, cb) {
    var state = this._writableState;
    if (typeof chunk === "function") {
      cb = chunk;
      chunk = null;
      encoding = null;
    } else if (typeof encoding === "function") {
      cb = encoding;
      encoding = null;
    }
    if (chunk !== null && chunk !== undefined)
      this.write(chunk, encoding);
    if (state.corked) {
      state.corked = 1;
      this.uncork();
    }
    if (!state.ending)
      endWritable(this, state, cb);
    return this;
  };
  Object.defineProperty(Writable.prototype, "writableLength", {
    enumerable: false,
    get: function get() {
      return this._writableState.length;
    }
  });
  function needFinish(state) {
    return state.ending && state.length === 0 && state.bufferedRequest === null && !state.finished && !state.writing;
  }
  function callFinal(stream, state) {
    stream._final(function(err) {
      state.pendingcb--;
      if (err) {
        errorOrDestroy(stream, err);
      }
      state.prefinished = true;
      stream.emit("prefinish");
      finishMaybe(stream, state);
    });
  }
  function prefinish(stream, state) {
    if (!state.prefinished && !state.finalCalled) {
      if (typeof stream._final === "function" && !state.destroyed) {
        state.pendingcb++;
        state.finalCalled = true;
        process.nextTick(callFinal, stream, state);
      } else {
        state.prefinished = true;
        stream.emit("prefinish");
      }
    }
  }
  function finishMaybe(stream, state) {
    var need = needFinish(state);
    if (need) {
      prefinish(stream, state);
      if (state.pendingcb === 0) {
        state.finished = true;
        stream.emit("finish");
        if (state.autoDestroy) {
          var rState = stream._readableState;
          if (!rState || rState.autoDestroy && rState.endEmitted) {
            stream.destroy();
          }
        }
      }
    }
    return need;
  }
  function endWritable(stream, state, cb) {
    state.ending = true;
    finishMaybe(stream, state);
    if (cb) {
      if (state.finished)
        process.nextTick(cb);
      else
        stream.once("finish", cb);
    }
    state.ended = true;
    stream.writable = false;
  }
  function onCorkedFinish(corkReq, state, err) {
    var entry = corkReq.entry;
    corkReq.entry = null;
    while (entry) {
      var cb = entry.callback;
      state.pendingcb--;
      cb(err);
      entry = entry.next;
    }
    state.corkedRequestsFree.next = corkReq;
  }
  Object.defineProperty(Writable.prototype, "destroyed", {
    enumerable: false,
    get: function get() {
      if (this._writableState === undefined) {
        return false;
      }
      return this._writableState.destroyed;
    },
    set: function set(value) {
      if (!this._writableState) {
        return;
      }
      this._writableState.destroyed = value;
    }
  });
  Writable.prototype.destroy = destroyImpl.destroy;
  Writable.prototype._undestroy = destroyImpl.undestroy;
  Writable.prototype._destroy = function(err, cb) {
    cb(err);
  };
});

// ../../node_modules/winston-transport/modern.js
var require_modern = __commonJS((exports, module) => {
  var util = __require("util");
  var Writable = require__stream_writable();
  var { LEVEL } = require_triple_beam();
  var TransportStream = module.exports = function TransportStream2(options = {}) {
    Writable.call(this, { objectMode: true, highWaterMark: options.highWaterMark });
    this.format = options.format;
    this.level = options.level;
    this.handleExceptions = options.handleExceptions;
    this.handleRejections = options.handleRejections;
    this.silent = options.silent;
    if (options.log)
      this.log = options.log;
    if (options.logv)
      this.logv = options.logv;
    if (options.close)
      this.close = options.close;
    this.once("pipe", (logger) => {
      this.levels = logger.levels;
      this.parent = logger;
    });
    this.once("unpipe", (src) => {
      if (src === this.parent) {
        this.parent = null;
        if (this.close) {
          this.close();
        }
      }
    });
  };
  util.inherits(TransportStream, Writable);
  TransportStream.prototype._write = function _write(info, enc, callback) {
    if (this.silent || info.exception === true && !this.handleExceptions) {
      return callback(null);
    }
    const level = this.level || this.parent && this.parent.level;
    if (!level || this.levels[level] >= this.levels[info[LEVEL]]) {
      if (info && !this.format) {
        return this.log(info, callback);
      }
      let errState;
      let transformed;
      try {
        transformed = this.format.transform(Object.assign({}, info), this.format.options);
      } catch (err) {
        errState = err;
      }
      if (errState || !transformed) {
        callback();
        if (errState)
          throw errState;
        return;
      }
      return this.log(transformed, callback);
    }
    this._writableState.sync = false;
    return callback(null);
  };
  TransportStream.prototype._writev = function _writev(chunks, callback) {
    if (this.logv) {
      const infos = chunks.filter(this._accept, this);
      if (!infos.length) {
        return callback(null);
      }
      return this.logv(infos, callback);
    }
    for (let i = 0;i < chunks.length; i++) {
      if (!this._accept(chunks[i]))
        continue;
      if (chunks[i].chunk && !this.format) {
        this.log(chunks[i].chunk, chunks[i].callback);
        continue;
      }
      let errState;
      let transformed;
      try {
        transformed = this.format.transform(Object.assign({}, chunks[i].chunk), this.format.options);
      } catch (err) {
        errState = err;
      }
      if (errState || !transformed) {
        chunks[i].callback();
        if (errState) {
          callback(null);
          throw errState;
        }
      } else {
        this.log(transformed, chunks[i].callback);
      }
    }
    return callback(null);
  };
  TransportStream.prototype._accept = function _accept(write) {
    const info = write.chunk;
    if (this.silent) {
      return false;
    }
    const level = this.level || this.parent && this.parent.level;
    if (info.exception === true || !level || this.levels[level] >= this.levels[info[LEVEL]]) {
      if (this.handleExceptions || info.exception !== true) {
        return true;
      }
    }
    return false;
  };
  TransportStream.prototype._nop = function _nop() {
    return;
  };
});

// ../../node_modules/winston-transport/legacy.js
var require_legacy = __commonJS((exports, module) => {
  var util = __require("util");
  var { LEVEL } = require_triple_beam();
  var TransportStream = require_modern();
  var LegacyTransportStream = module.exports = function LegacyTransportStream2(options = {}) {
    TransportStream.call(this, options);
    if (!options.transport || typeof options.transport.log !== "function") {
      throw new Error("Invalid transport, must be an object with a log method.");
    }
    this.transport = options.transport;
    this.level = this.level || options.transport.level;
    this.handleExceptions = this.handleExceptions || options.transport.handleExceptions;
    this._deprecated();
    function transportError(err) {
      this.emit("error", err, this.transport);
    }
    if (!this.transport.__winstonError) {
      this.transport.__winstonError = transportError.bind(this);
      this.transport.on("error", this.transport.__winstonError);
    }
  };
  util.inherits(LegacyTransportStream, TransportStream);
  LegacyTransportStream.prototype._write = function _write(info, enc, callback) {
    if (this.silent || info.exception === true && !this.handleExceptions) {
      return callback(null);
    }
    if (!this.level || this.levels[this.level] >= this.levels[info[LEVEL]]) {
      this.transport.log(info[LEVEL], info.message, info, this._nop);
    }
    callback(null);
  };
  LegacyTransportStream.prototype._writev = function _writev(chunks, callback) {
    for (let i = 0;i < chunks.length; i++) {
      if (this._accept(chunks[i])) {
        this.transport.log(chunks[i].chunk[LEVEL], chunks[i].chunk.message, chunks[i].chunk, this._nop);
        chunks[i].callback();
      }
    }
    return callback(null);
  };
  LegacyTransportStream.prototype._deprecated = function _deprecated() {
    console.error([
      `${this.transport.name} is a legacy winston transport. Consider upgrading: `,
      "- Upgrade docs: https://github.com/winstonjs/winston/blob/master/UPGRADE-3.0.md"
    ].join(`
`));
  };
  LegacyTransportStream.prototype.close = function close() {
    if (this.transport.close) {
      this.transport.close();
    }
    if (this.transport.__winstonError) {
      this.transport.removeListener("error", this.transport.__winstonError);
      this.transport.__winstonError = null;
    }
  };
});

// ../../node_modules/winston-transport/index.js
var require_winston_transport = __commonJS((exports, module) => {
  module.exports = require_modern();
  module.exports.LegacyTransportStream = require_legacy();
});

// ../../node_modules/moment/moment.js
var require_moment = __commonJS((exports, module) => {
  //! moment.js
  //! version : 2.30.1
  //! authors : Tim Wood, Iskren Chernev, Moment.js contributors
  //! license : MIT
  //! momentjs.com
  (function(global2, factory) {
    typeof exports === "object" && typeof module !== "undefined" ? module.exports = factory() : typeof define === "function" && define.amd ? define(factory) : global2.moment = factory();
  })(exports, function() {
    var hookCallback;
    function hooks() {
      return hookCallback.apply(null, arguments);
    }
    function setHookCallback(callback) {
      hookCallback = callback;
    }
    function isArray(input) {
      return input instanceof Array || Object.prototype.toString.call(input) === "[object Array]";
    }
    function isObject(input) {
      return input != null && Object.prototype.toString.call(input) === "[object Object]";
    }
    function hasOwnProp(a, b) {
      return Object.prototype.hasOwnProperty.call(a, b);
    }
    function isObjectEmpty(obj) {
      if (Object.getOwnPropertyNames) {
        return Object.getOwnPropertyNames(obj).length === 0;
      } else {
        var k;
        for (k in obj) {
          if (hasOwnProp(obj, k)) {
            return false;
          }
        }
        return true;
      }
    }
    function isUndefined(input) {
      return input === undefined;
    }
    function isNumber(input) {
      return typeof input === "number" || Object.prototype.toString.call(input) === "[object Number]";
    }
    function isDate(input) {
      return input instanceof Date || Object.prototype.toString.call(input) === "[object Date]";
    }
    function map(arr, fn) {
      var res = [], i, arrLen = arr.length;
      for (i = 0;i < arrLen; ++i) {
        res.push(fn(arr[i], i));
      }
      return res;
    }
    function extend(a, b) {
      for (var i in b) {
        if (hasOwnProp(b, i)) {
          a[i] = b[i];
        }
      }
      if (hasOwnProp(b, "toString")) {
        a.toString = b.toString;
      }
      if (hasOwnProp(b, "valueOf")) {
        a.valueOf = b.valueOf;
      }
      return a;
    }
    function createUTC(input, format2, locale2, strict) {
      return createLocalOrUTC(input, format2, locale2, strict, true).utc();
    }
    function defaultParsingFlags() {
      return {
        empty: false,
        unusedTokens: [],
        unusedInput: [],
        overflow: -2,
        charsLeftOver: 0,
        nullInput: false,
        invalidEra: null,
        invalidMonth: null,
        invalidFormat: false,
        userInvalidated: false,
        iso: false,
        parsedDateParts: [],
        era: null,
        meridiem: null,
        rfc2822: false,
        weekdayMismatch: false
      };
    }
    function getParsingFlags(m) {
      if (m._pf == null) {
        m._pf = defaultParsingFlags();
      }
      return m._pf;
    }
    var some;
    if (Array.prototype.some) {
      some = Array.prototype.some;
    } else {
      some = function(fun) {
        var t = Object(this), len = t.length >>> 0, i;
        for (i = 0;i < len; i++) {
          if (i in t && fun.call(this, t[i], i, t)) {
            return true;
          }
        }
        return false;
      };
    }
    function isValid(m) {
      var flags = null, parsedParts = false, isNowValid = m._d && !isNaN(m._d.getTime());
      if (isNowValid) {
        flags = getParsingFlags(m);
        parsedParts = some.call(flags.parsedDateParts, function(i) {
          return i != null;
        });
        isNowValid = flags.overflow < 0 && !flags.empty && !flags.invalidEra && !flags.invalidMonth && !flags.invalidWeekday && !flags.weekdayMismatch && !flags.nullInput && !flags.invalidFormat && !flags.userInvalidated && (!flags.meridiem || flags.meridiem && parsedParts);
        if (m._strict) {
          isNowValid = isNowValid && flags.charsLeftOver === 0 && flags.unusedTokens.length === 0 && flags.bigHour === undefined;
        }
      }
      if (Object.isFrozen == null || !Object.isFrozen(m)) {
        m._isValid = isNowValid;
      } else {
        return isNowValid;
      }
      return m._isValid;
    }
    function createInvalid(flags) {
      var m = createUTC(NaN);
      if (flags != null) {
        extend(getParsingFlags(m), flags);
      } else {
        getParsingFlags(m).userInvalidated = true;
      }
      return m;
    }
    var momentProperties = hooks.momentProperties = [], updateInProgress = false;
    function copyConfig(to2, from2) {
      var i, prop, val, momentPropertiesLen = momentProperties.length;
      if (!isUndefined(from2._isAMomentObject)) {
        to2._isAMomentObject = from2._isAMomentObject;
      }
      if (!isUndefined(from2._i)) {
        to2._i = from2._i;
      }
      if (!isUndefined(from2._f)) {
        to2._f = from2._f;
      }
      if (!isUndefined(from2._l)) {
        to2._l = from2._l;
      }
      if (!isUndefined(from2._strict)) {
        to2._strict = from2._strict;
      }
      if (!isUndefined(from2._tzm)) {
        to2._tzm = from2._tzm;
      }
      if (!isUndefined(from2._isUTC)) {
        to2._isUTC = from2._isUTC;
      }
      if (!isUndefined(from2._offset)) {
        to2._offset = from2._offset;
      }
      if (!isUndefined(from2._pf)) {
        to2._pf = getParsingFlags(from2);
      }
      if (!isUndefined(from2._locale)) {
        to2._locale = from2._locale;
      }
      if (momentPropertiesLen > 0) {
        for (i = 0;i < momentPropertiesLen; i++) {
          prop = momentProperties[i];
          val = from2[prop];
          if (!isUndefined(val)) {
            to2[prop] = val;
          }
        }
      }
      return to2;
    }
    function Moment(config) {
      copyConfig(this, config);
      this._d = new Date(config._d != null ? config._d.getTime() : NaN);
      if (!this.isValid()) {
        this._d = new Date(NaN);
      }
      if (updateInProgress === false) {
        updateInProgress = true;
        hooks.updateOffset(this);
        updateInProgress = false;
      }
    }
    function isMoment(obj) {
      return obj instanceof Moment || obj != null && obj._isAMomentObject != null;
    }
    function warn(msg) {
      if (hooks.suppressDeprecationWarnings === false && typeof console !== "undefined" && console.warn) {
        console.warn("Deprecation warning: " + msg);
      }
    }
    function deprecate(msg, fn) {
      var firstTime = true;
      return extend(function() {
        if (hooks.deprecationHandler != null) {
          hooks.deprecationHandler(null, msg);
        }
        if (firstTime) {
          var args = [], arg, i, key, argLen = arguments.length;
          for (i = 0;i < argLen; i++) {
            arg = "";
            if (typeof arguments[i] === "object") {
              arg += `
[` + i + "] ";
              for (key in arguments[0]) {
                if (hasOwnProp(arguments[0], key)) {
                  arg += key + ": " + arguments[0][key] + ", ";
                }
              }
              arg = arg.slice(0, -2);
            } else {
              arg = arguments[i];
            }
            args.push(arg);
          }
          warn(msg + `
Arguments: ` + Array.prototype.slice.call(args).join("") + `
` + new Error().stack);
          firstTime = false;
        }
        return fn.apply(this, arguments);
      }, fn);
    }
    var deprecations = {};
    function deprecateSimple(name, msg) {
      if (hooks.deprecationHandler != null) {
        hooks.deprecationHandler(name, msg);
      }
      if (!deprecations[name]) {
        warn(msg);
        deprecations[name] = true;
      }
    }
    hooks.suppressDeprecationWarnings = false;
    hooks.deprecationHandler = null;
    function isFunction(input) {
      return typeof Function !== "undefined" && input instanceof Function || Object.prototype.toString.call(input) === "[object Function]";
    }
    function set(config) {
      var prop, i;
      for (i in config) {
        if (hasOwnProp(config, i)) {
          prop = config[i];
          if (isFunction(prop)) {
            this[i] = prop;
          } else {
            this["_" + i] = prop;
          }
        }
      }
      this._config = config;
      this._dayOfMonthOrdinalParseLenient = new RegExp((this._dayOfMonthOrdinalParse.source || this._ordinalParse.source) + "|" + /\d{1,2}/.source);
    }
    function mergeConfigs(parentConfig, childConfig) {
      var res = extend({}, parentConfig), prop;
      for (prop in childConfig) {
        if (hasOwnProp(childConfig, prop)) {
          if (isObject(parentConfig[prop]) && isObject(childConfig[prop])) {
            res[prop] = {};
            extend(res[prop], parentConfig[prop]);
            extend(res[prop], childConfig[prop]);
          } else if (childConfig[prop] != null) {
            res[prop] = childConfig[prop];
          } else {
            delete res[prop];
          }
        }
      }
      for (prop in parentConfig) {
        if (hasOwnProp(parentConfig, prop) && !hasOwnProp(childConfig, prop) && isObject(parentConfig[prop])) {
          res[prop] = extend({}, res[prop]);
        }
      }
      return res;
    }
    function Locale(config) {
      if (config != null) {
        this.set(config);
      }
    }
    var keys;
    if (Object.keys) {
      keys = Object.keys;
    } else {
      keys = function(obj) {
        var i, res = [];
        for (i in obj) {
          if (hasOwnProp(obj, i)) {
            res.push(i);
          }
        }
        return res;
      };
    }
    var defaultCalendar = {
      sameDay: "[Today at] LT",
      nextDay: "[Tomorrow at] LT",
      nextWeek: "dddd [at] LT",
      lastDay: "[Yesterday at] LT",
      lastWeek: "[Last] dddd [at] LT",
      sameElse: "L"
    };
    function calendar(key, mom, now2) {
      var output = this._calendar[key] || this._calendar["sameElse"];
      return isFunction(output) ? output.call(mom, now2) : output;
    }
    function zeroFill(number, targetLength, forceSign) {
      var absNumber = "" + Math.abs(number), zerosToFill = targetLength - absNumber.length, sign2 = number >= 0;
      return (sign2 ? forceSign ? "+" : "" : "-") + Math.pow(10, Math.max(0, zerosToFill)).toString().substr(1) + absNumber;
    }
    var formattingTokens = /(\[[^\[]*\])|(\\)?([Hh]mm(ss)?|Mo|MM?M?M?|Do|DDDo|DD?D?D?|ddd?d?|do?|w[o|w]?|W[o|W]?|Qo?|N{1,5}|YYYYYY|YYYYY|YYYY|YY|y{2,4}|yo?|gg(ggg?)?|GG(GGG?)?|e|E|a|A|hh?|HH?|kk?|mm?|ss?|S{1,9}|x|X|zz?|ZZ?|.)/g, localFormattingTokens = /(\[[^\[]*\])|(\\)?(LTS|LT|LL?L?L?|l{1,4})/g, formatFunctions = {}, formatTokenFunctions = {};
    function addFormatToken(token2, padded, ordinal2, callback) {
      var func = callback;
      if (typeof callback === "string") {
        func = function() {
          return this[callback]();
        };
      }
      if (token2) {
        formatTokenFunctions[token2] = func;
      }
      if (padded) {
        formatTokenFunctions[padded[0]] = function() {
          return zeroFill(func.apply(this, arguments), padded[1], padded[2]);
        };
      }
      if (ordinal2) {
        formatTokenFunctions[ordinal2] = function() {
          return this.localeData().ordinal(func.apply(this, arguments), token2);
        };
      }
    }
    function removeFormattingTokens(input) {
      if (input.match(/\[[\s\S]/)) {
        return input.replace(/^\[|\]$/g, "");
      }
      return input.replace(/\\/g, "");
    }
    function makeFormatFunction(format2) {
      var array = format2.match(formattingTokens), i, length;
      for (i = 0, length = array.length;i < length; i++) {
        if (formatTokenFunctions[array[i]]) {
          array[i] = formatTokenFunctions[array[i]];
        } else {
          array[i] = removeFormattingTokens(array[i]);
        }
      }
      return function(mom) {
        var output = "", i2;
        for (i2 = 0;i2 < length; i2++) {
          output += isFunction(array[i2]) ? array[i2].call(mom, format2) : array[i2];
        }
        return output;
      };
    }
    function formatMoment(m, format2) {
      if (!m.isValid()) {
        return m.localeData().invalidDate();
      }
      format2 = expandFormat(format2, m.localeData());
      formatFunctions[format2] = formatFunctions[format2] || makeFormatFunction(format2);
      return formatFunctions[format2](m);
    }
    function expandFormat(format2, locale2) {
      var i = 5;
      function replaceLongDateFormatTokens(input) {
        return locale2.longDateFormat(input) || input;
      }
      localFormattingTokens.lastIndex = 0;
      while (i >= 0 && localFormattingTokens.test(format2)) {
        format2 = format2.replace(localFormattingTokens, replaceLongDateFormatTokens);
        localFormattingTokens.lastIndex = 0;
        i -= 1;
      }
      return format2;
    }
    var defaultLongDateFormat = {
      LTS: "h:mm:ss A",
      LT: "h:mm A",
      L: "MM/DD/YYYY",
      LL: "MMMM D, YYYY",
      LLL: "MMMM D, YYYY h:mm A",
      LLLL: "dddd, MMMM D, YYYY h:mm A"
    };
    function longDateFormat(key) {
      var format2 = this._longDateFormat[key], formatUpper = this._longDateFormat[key.toUpperCase()];
      if (format2 || !formatUpper) {
        return format2;
      }
      this._longDateFormat[key] = formatUpper.match(formattingTokens).map(function(tok) {
        if (tok === "MMMM" || tok === "MM" || tok === "DD" || tok === "dddd") {
          return tok.slice(1);
        }
        return tok;
      }).join("");
      return this._longDateFormat[key];
    }
    var defaultInvalidDate = "Invalid date";
    function invalidDate() {
      return this._invalidDate;
    }
    var defaultOrdinal = "%d", defaultDayOfMonthOrdinalParse = /\d{1,2}/;
    function ordinal(number) {
      return this._ordinal.replace("%d", number);
    }
    var defaultRelativeTime = {
      future: "in %s",
      past: "%s ago",
      s: "a few seconds",
      ss: "%d seconds",
      m: "a minute",
      mm: "%d minutes",
      h: "an hour",
      hh: "%d hours",
      d: "a day",
      dd: "%d days",
      w: "a week",
      ww: "%d weeks",
      M: "a month",
      MM: "%d months",
      y: "a year",
      yy: "%d years"
    };
    function relativeTime(number, withoutSuffix, string, isFuture) {
      var output = this._relativeTime[string];
      return isFunction(output) ? output(number, withoutSuffix, string, isFuture) : output.replace(/%d/i, number);
    }
    function pastFuture(diff2, output) {
      var format2 = this._relativeTime[diff2 > 0 ? "future" : "past"];
      return isFunction(format2) ? format2(output) : format2.replace(/%s/i, output);
    }
    var aliases = {
      D: "date",
      dates: "date",
      date: "date",
      d: "day",
      days: "day",
      day: "day",
      e: "weekday",
      weekdays: "weekday",
      weekday: "weekday",
      E: "isoWeekday",
      isoweekdays: "isoWeekday",
      isoweekday: "isoWeekday",
      DDD: "dayOfYear",
      dayofyears: "dayOfYear",
      dayofyear: "dayOfYear",
      h: "hour",
      hours: "hour",
      hour: "hour",
      ms: "millisecond",
      milliseconds: "millisecond",
      millisecond: "millisecond",
      m: "minute",
      minutes: "minute",
      minute: "minute",
      M: "month",
      months: "month",
      month: "month",
      Q: "quarter",
      quarters: "quarter",
      quarter: "quarter",
      s: "second",
      seconds: "second",
      second: "second",
      gg: "weekYear",
      weekyears: "weekYear",
      weekyear: "weekYear",
      GG: "isoWeekYear",
      isoweekyears: "isoWeekYear",
      isoweekyear: "isoWeekYear",
      w: "week",
      weeks: "week",
      week: "week",
      W: "isoWeek",
      isoweeks: "isoWeek",
      isoweek: "isoWeek",
      y: "year",
      years: "year",
      year: "year"
    };
    function normalizeUnits(units) {
      return typeof units === "string" ? aliases[units] || aliases[units.toLowerCase()] : undefined;
    }
    function normalizeObjectUnits(inputObject) {
      var normalizedInput = {}, normalizedProp, prop;
      for (prop in inputObject) {
        if (hasOwnProp(inputObject, prop)) {
          normalizedProp = normalizeUnits(prop);
          if (normalizedProp) {
            normalizedInput[normalizedProp] = inputObject[prop];
          }
        }
      }
      return normalizedInput;
    }
    var priorities = {
      date: 9,
      day: 11,
      weekday: 11,
      isoWeekday: 11,
      dayOfYear: 4,
      hour: 13,
      millisecond: 16,
      minute: 14,
      month: 8,
      quarter: 7,
      second: 15,
      weekYear: 1,
      isoWeekYear: 1,
      week: 5,
      isoWeek: 5,
      year: 1
    };
    function getPrioritizedUnits(unitsObj) {
      var units = [], u;
      for (u in unitsObj) {
        if (hasOwnProp(unitsObj, u)) {
          units.push({ unit: u, priority: priorities[u] });
        }
      }
      units.sort(function(a, b) {
        return a.priority - b.priority;
      });
      return units;
    }
    var match1 = /\d/, match2 = /\d\d/, match3 = /\d{3}/, match4 = /\d{4}/, match6 = /[+-]?\d{6}/, match1to2 = /\d\d?/, match3to4 = /\d\d\d\d?/, match5to6 = /\d\d\d\d\d\d?/, match1to3 = /\d{1,3}/, match1to4 = /\d{1,4}/, match1to6 = /[+-]?\d{1,6}/, matchUnsigned = /\d+/, matchSigned = /[+-]?\d+/, matchOffset = /Z|[+-]\d\d:?\d\d/gi, matchShortOffset = /Z|[+-]\d\d(?::?\d\d)?/gi, matchTimestamp = /[+-]?\d+(\.\d{1,3})?/, matchWord = /[0-9]{0,256}['a-z\u00A0-\u05FF\u0700-\uD7FF\uF900-\uFDCF\uFDF0-\uFF07\uFF10-\uFFEF]{1,256}|[\u0600-\u06FF\/]{1,256}(\s*?[\u0600-\u06FF]{1,256}){1,2}/i, match1to2NoLeadingZero = /^[1-9]\d?/, match1to2HasZero = /^([1-9]\d|\d)/, regexes;
    regexes = {};
    function addRegexToken(token2, regex, strictRegex) {
      regexes[token2] = isFunction(regex) ? regex : function(isStrict, localeData2) {
        return isStrict && strictRegex ? strictRegex : regex;
      };
    }
    function getParseRegexForToken(token2, config) {
      if (!hasOwnProp(regexes, token2)) {
        return new RegExp(unescapeFormat(token2));
      }
      return regexes[token2](config._strict, config._locale);
    }
    function unescapeFormat(s) {
      return regexEscape(s.replace("\\", "").replace(/\\(\[)|\\(\])|\[([^\]\[]*)\]|\\(.)/g, function(matched, p1, p2, p3, p4) {
        return p1 || p2 || p3 || p4;
      }));
    }
    function regexEscape(s) {
      return s.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
    }
    function absFloor(number) {
      if (number < 0) {
        return Math.ceil(number) || 0;
      } else {
        return Math.floor(number);
      }
    }
    function toInt(argumentForCoercion) {
      var coercedNumber = +argumentForCoercion, value = 0;
      if (coercedNumber !== 0 && isFinite(coercedNumber)) {
        value = absFloor(coercedNumber);
      }
      return value;
    }
    var tokens = {};
    function addParseToken(token2, callback) {
      var i, func = callback, tokenLen;
      if (typeof token2 === "string") {
        token2 = [token2];
      }
      if (isNumber(callback)) {
        func = function(input, array) {
          array[callback] = toInt(input);
        };
      }
      tokenLen = token2.length;
      for (i = 0;i < tokenLen; i++) {
        tokens[token2[i]] = func;
      }
    }
    function addWeekParseToken(token2, callback) {
      addParseToken(token2, function(input, array, config, token3) {
        config._w = config._w || {};
        callback(input, config._w, config, token3);
      });
    }
    function addTimeToArrayFromToken(token2, input, config) {
      if (input != null && hasOwnProp(tokens, token2)) {
        tokens[token2](input, config._a, config, token2);
      }
    }
    function isLeapYear(year) {
      return year % 4 === 0 && year % 100 !== 0 || year % 400 === 0;
    }
    var YEAR = 0, MONTH = 1, DATE = 2, HOUR = 3, MINUTE = 4, SECOND = 5, MILLISECOND = 6, WEEK = 7, WEEKDAY = 8;
    addFormatToken("Y", 0, 0, function() {
      var y = this.year();
      return y <= 9999 ? zeroFill(y, 4) : "+" + y;
    });
    addFormatToken(0, ["YY", 2], 0, function() {
      return this.year() % 100;
    });
    addFormatToken(0, ["YYYY", 4], 0, "year");
    addFormatToken(0, ["YYYYY", 5], 0, "year");
    addFormatToken(0, ["YYYYYY", 6, true], 0, "year");
    addRegexToken("Y", matchSigned);
    addRegexToken("YY", match1to2, match2);
    addRegexToken("YYYY", match1to4, match4);
    addRegexToken("YYYYY", match1to6, match6);
    addRegexToken("YYYYYY", match1to6, match6);
    addParseToken(["YYYYY", "YYYYYY"], YEAR);
    addParseToken("YYYY", function(input, array) {
      array[YEAR] = input.length === 2 ? hooks.parseTwoDigitYear(input) : toInt(input);
    });
    addParseToken("YY", function(input, array) {
      array[YEAR] = hooks.parseTwoDigitYear(input);
    });
    addParseToken("Y", function(input, array) {
      array[YEAR] = parseInt(input, 10);
    });
    function daysInYear(year) {
      return isLeapYear(year) ? 366 : 365;
    }
    hooks.parseTwoDigitYear = function(input) {
      return toInt(input) + (toInt(input) > 68 ? 1900 : 2000);
    };
    var getSetYear = makeGetSet("FullYear", true);
    function getIsLeapYear() {
      return isLeapYear(this.year());
    }
    function makeGetSet(unit, keepTime) {
      return function(value) {
        if (value != null) {
          set$1(this, unit, value);
          hooks.updateOffset(this, keepTime);
          return this;
        } else {
          return get(this, unit);
        }
      };
    }
    function get(mom, unit) {
      if (!mom.isValid()) {
        return NaN;
      }
      var { _d: d, _isUTC: isUTC } = mom;
      switch (unit) {
        case "Milliseconds":
          return isUTC ? d.getUTCMilliseconds() : d.getMilliseconds();
        case "Seconds":
          return isUTC ? d.getUTCSeconds() : d.getSeconds();
        case "Minutes":
          return isUTC ? d.getUTCMinutes() : d.getMinutes();
        case "Hours":
          return isUTC ? d.getUTCHours() : d.getHours();
        case "Date":
          return isUTC ? d.getUTCDate() : d.getDate();
        case "Day":
          return isUTC ? d.getUTCDay() : d.getDay();
        case "Month":
          return isUTC ? d.getUTCMonth() : d.getMonth();
        case "FullYear":
          return isUTC ? d.getUTCFullYear() : d.getFullYear();
        default:
          return NaN;
      }
    }
    function set$1(mom, unit, value) {
      var d, isUTC, year, month, date;
      if (!mom.isValid() || isNaN(value)) {
        return;
      }
      d = mom._d;
      isUTC = mom._isUTC;
      switch (unit) {
        case "Milliseconds":
          return void (isUTC ? d.setUTCMilliseconds(value) : d.setMilliseconds(value));
        case "Seconds":
          return void (isUTC ? d.setUTCSeconds(value) : d.setSeconds(value));
        case "Minutes":
          return void (isUTC ? d.setUTCMinutes(value) : d.setMinutes(value));
        case "Hours":
          return void (isUTC ? d.setUTCHours(value) : d.setHours(value));
        case "Date":
          return void (isUTC ? d.setUTCDate(value) : d.setDate(value));
        case "FullYear":
          break;
        default:
          return;
      }
      year = value;
      month = mom.month();
      date = mom.date();
      date = date === 29 && month === 1 && !isLeapYear(year) ? 28 : date;
      isUTC ? d.setUTCFullYear(year, month, date) : d.setFullYear(year, month, date);
    }
    function stringGet(units) {
      units = normalizeUnits(units);
      if (isFunction(this[units])) {
        return this[units]();
      }
      return this;
    }
    function stringSet(units, value) {
      if (typeof units === "object") {
        units = normalizeObjectUnits(units);
        var prioritized = getPrioritizedUnits(units), i, prioritizedLen = prioritized.length;
        for (i = 0;i < prioritizedLen; i++) {
          this[prioritized[i].unit](units[prioritized[i].unit]);
        }
      } else {
        units = normalizeUnits(units);
        if (isFunction(this[units])) {
          return this[units](value);
        }
      }
      return this;
    }
    function mod(n, x) {
      return (n % x + x) % x;
    }
    var indexOf;
    if (Array.prototype.indexOf) {
      indexOf = Array.prototype.indexOf;
    } else {
      indexOf = function(o) {
        var i;
        for (i = 0;i < this.length; ++i) {
          if (this[i] === o) {
            return i;
          }
        }
        return -1;
      };
    }
    function daysInMonth(year, month) {
      if (isNaN(year) || isNaN(month)) {
        return NaN;
      }
      var modMonth = mod(month, 12);
      year += (month - modMonth) / 12;
      return modMonth === 1 ? isLeapYear(year) ? 29 : 28 : 31 - modMonth % 7 % 2;
    }
    addFormatToken("M", ["MM", 2], "Mo", function() {
      return this.month() + 1;
    });
    addFormatToken("MMM", 0, 0, function(format2) {
      return this.localeData().monthsShort(this, format2);
    });
    addFormatToken("MMMM", 0, 0, function(format2) {
      return this.localeData().months(this, format2);
    });
    addRegexToken("M", match1to2, match1to2NoLeadingZero);
    addRegexToken("MM", match1to2, match2);
    addRegexToken("MMM", function(isStrict, locale2) {
      return locale2.monthsShortRegex(isStrict);
    });
    addRegexToken("MMMM", function(isStrict, locale2) {
      return locale2.monthsRegex(isStrict);
    });
    addParseToken(["M", "MM"], function(input, array) {
      array[MONTH] = toInt(input) - 1;
    });
    addParseToken(["MMM", "MMMM"], function(input, array, config, token2) {
      var month = config._locale.monthsParse(input, token2, config._strict);
      if (month != null) {
        array[MONTH] = month;
      } else {
        getParsingFlags(config).invalidMonth = input;
      }
    });
    var defaultLocaleMonths = "January_February_March_April_May_June_July_August_September_October_November_December".split("_"), defaultLocaleMonthsShort = "Jan_Feb_Mar_Apr_May_Jun_Jul_Aug_Sep_Oct_Nov_Dec".split("_"), MONTHS_IN_FORMAT = /D[oD]?(\[[^\[\]]*\]|\s)+MMMM?/, defaultMonthsShortRegex = matchWord, defaultMonthsRegex = matchWord;
    function localeMonths(m, format2) {
      if (!m) {
        return isArray(this._months) ? this._months : this._months["standalone"];
      }
      return isArray(this._months) ? this._months[m.month()] : this._months[(this._months.isFormat || MONTHS_IN_FORMAT).test(format2) ? "format" : "standalone"][m.month()];
    }
    function localeMonthsShort(m, format2) {
      if (!m) {
        return isArray(this._monthsShort) ? this._monthsShort : this._monthsShort["standalone"];
      }
      return isArray(this._monthsShort) ? this._monthsShort[m.month()] : this._monthsShort[MONTHS_IN_FORMAT.test(format2) ? "format" : "standalone"][m.month()];
    }
    function handleStrictParse(monthName, format2, strict) {
      var i, ii, mom, llc = monthName.toLocaleLowerCase();
      if (!this._monthsParse) {
        this._monthsParse = [];
        this._longMonthsParse = [];
        this._shortMonthsParse = [];
        for (i = 0;i < 12; ++i) {
          mom = createUTC([2000, i]);
          this._shortMonthsParse[i] = this.monthsShort(mom, "").toLocaleLowerCase();
          this._longMonthsParse[i] = this.months(mom, "").toLocaleLowerCase();
        }
      }
      if (strict) {
        if (format2 === "MMM") {
          ii = indexOf.call(this._shortMonthsParse, llc);
          return ii !== -1 ? ii : null;
        } else {
          ii = indexOf.call(this._longMonthsParse, llc);
          return ii !== -1 ? ii : null;
        }
      } else {
        if (format2 === "MMM") {
          ii = indexOf.call(this._shortMonthsParse, llc);
          if (ii !== -1) {
            return ii;
          }
          ii = indexOf.call(this._longMonthsParse, llc);
          return ii !== -1 ? ii : null;
        } else {
          ii = indexOf.call(this._longMonthsParse, llc);
          if (ii !== -1) {
            return ii;
          }
          ii = indexOf.call(this._shortMonthsParse, llc);
          return ii !== -1 ? ii : null;
        }
      }
    }
    function localeMonthsParse(monthName, format2, strict) {
      var i, mom, regex;
      if (this._monthsParseExact) {
        return handleStrictParse.call(this, monthName, format2, strict);
      }
      if (!this._monthsParse) {
        this._monthsParse = [];
        this._longMonthsParse = [];
        this._shortMonthsParse = [];
      }
      for (i = 0;i < 12; i++) {
        mom = createUTC([2000, i]);
        if (strict && !this._longMonthsParse[i]) {
          this._longMonthsParse[i] = new RegExp("^" + this.months(mom, "").replace(".", "") + "$", "i");
          this._shortMonthsParse[i] = new RegExp("^" + this.monthsShort(mom, "").replace(".", "") + "$", "i");
        }
        if (!strict && !this._monthsParse[i]) {
          regex = "^" + this.months(mom, "") + "|^" + this.monthsShort(mom, "");
          this._monthsParse[i] = new RegExp(regex.replace(".", ""), "i");
        }
        if (strict && format2 === "MMMM" && this._longMonthsParse[i].test(monthName)) {
          return i;
        } else if (strict && format2 === "MMM" && this._shortMonthsParse[i].test(monthName)) {
          return i;
        } else if (!strict && this._monthsParse[i].test(monthName)) {
          return i;
        }
      }
    }
    function setMonth(mom, value) {
      if (!mom.isValid()) {
        return mom;
      }
      if (typeof value === "string") {
        if (/^\d+$/.test(value)) {
          value = toInt(value);
        } else {
          value = mom.localeData().monthsParse(value);
          if (!isNumber(value)) {
            return mom;
          }
        }
      }
      var month = value, date = mom.date();
      date = date < 29 ? date : Math.min(date, daysInMonth(mom.year(), month));
      mom._isUTC ? mom._d.setUTCMonth(month, date) : mom._d.setMonth(month, date);
      return mom;
    }
    function getSetMonth(value) {
      if (value != null) {
        setMonth(this, value);
        hooks.updateOffset(this, true);
        return this;
      } else {
        return get(this, "Month");
      }
    }
    function getDaysInMonth() {
      return daysInMonth(this.year(), this.month());
    }
    function monthsShortRegex(isStrict) {
      if (this._monthsParseExact) {
        if (!hasOwnProp(this, "_monthsRegex")) {
          computeMonthsParse.call(this);
        }
        if (isStrict) {
          return this._monthsShortStrictRegex;
        } else {
          return this._monthsShortRegex;
        }
      } else {
        if (!hasOwnProp(this, "_monthsShortRegex")) {
          this._monthsShortRegex = defaultMonthsShortRegex;
        }
        return this._monthsShortStrictRegex && isStrict ? this._monthsShortStrictRegex : this._monthsShortRegex;
      }
    }
    function monthsRegex(isStrict) {
      if (this._monthsParseExact) {
        if (!hasOwnProp(this, "_monthsRegex")) {
          computeMonthsParse.call(this);
        }
        if (isStrict) {
          return this._monthsStrictRegex;
        } else {
          return this._monthsRegex;
        }
      } else {
        if (!hasOwnProp(this, "_monthsRegex")) {
          this._monthsRegex = defaultMonthsRegex;
        }
        return this._monthsStrictRegex && isStrict ? this._monthsStrictRegex : this._monthsRegex;
      }
    }
    function computeMonthsParse() {
      function cmpLenRev(a, b) {
        return b.length - a.length;
      }
      var shortPieces = [], longPieces = [], mixedPieces = [], i, mom, shortP, longP;
      for (i = 0;i < 12; i++) {
        mom = createUTC([2000, i]);
        shortP = regexEscape(this.monthsShort(mom, ""));
        longP = regexEscape(this.months(mom, ""));
        shortPieces.push(shortP);
        longPieces.push(longP);
        mixedPieces.push(longP);
        mixedPieces.push(shortP);
      }
      shortPieces.sort(cmpLenRev);
      longPieces.sort(cmpLenRev);
      mixedPieces.sort(cmpLenRev);
      this._monthsRegex = new RegExp("^(" + mixedPieces.join("|") + ")", "i");
      this._monthsShortRegex = this._monthsRegex;
      this._monthsStrictRegex = new RegExp("^(" + longPieces.join("|") + ")", "i");
      this._monthsShortStrictRegex = new RegExp("^(" + shortPieces.join("|") + ")", "i");
    }
    function createDate(y, m, d, h, M, s, ms) {
      var date;
      if (y < 100 && y >= 0) {
        date = new Date(y + 400, m, d, h, M, s, ms);
        if (isFinite(date.getFullYear())) {
          date.setFullYear(y);
        }
      } else {
        date = new Date(y, m, d, h, M, s, ms);
      }
      return date;
    }
    function createUTCDate(y) {
      var date, args;
      if (y < 100 && y >= 0) {
        args = Array.prototype.slice.call(arguments);
        args[0] = y + 400;
        date = new Date(Date.UTC.apply(null, args));
        if (isFinite(date.getUTCFullYear())) {
          date.setUTCFullYear(y);
        }
      } else {
        date = new Date(Date.UTC.apply(null, arguments));
      }
      return date;
    }
    function firstWeekOffset(year, dow, doy) {
      var fwd = 7 + dow - doy, fwdlw = (7 + createUTCDate(year, 0, fwd).getUTCDay() - dow) % 7;
      return -fwdlw + fwd - 1;
    }
    function dayOfYearFromWeeks(year, week, weekday, dow, doy) {
      var localWeekday = (7 + weekday - dow) % 7, weekOffset = firstWeekOffset(year, dow, doy), dayOfYear = 1 + 7 * (week - 1) + localWeekday + weekOffset, resYear, resDayOfYear;
      if (dayOfYear <= 0) {
        resYear = year - 1;
        resDayOfYear = daysInYear(resYear) + dayOfYear;
      } else if (dayOfYear > daysInYear(year)) {
        resYear = year + 1;
        resDayOfYear = dayOfYear - daysInYear(year);
      } else {
        resYear = year;
        resDayOfYear = dayOfYear;
      }
      return {
        year: resYear,
        dayOfYear: resDayOfYear
      };
    }
    function weekOfYear(mom, dow, doy) {
      var weekOffset = firstWeekOffset(mom.year(), dow, doy), week = Math.floor((mom.dayOfYear() - weekOffset - 1) / 7) + 1, resWeek, resYear;
      if (week < 1) {
        resYear = mom.year() - 1;
        resWeek = week + weeksInYear(resYear, dow, doy);
      } else if (week > weeksInYear(mom.year(), dow, doy)) {
        resWeek = week - weeksInYear(mom.year(), dow, doy);
        resYear = mom.year() + 1;
      } else {
        resYear = mom.year();
        resWeek = week;
      }
      return {
        week: resWeek,
        year: resYear
      };
    }
    function weeksInYear(year, dow, doy) {
      var weekOffset = firstWeekOffset(year, dow, doy), weekOffsetNext = firstWeekOffset(year + 1, dow, doy);
      return (daysInYear(year) - weekOffset + weekOffsetNext) / 7;
    }
    addFormatToken("w", ["ww", 2], "wo", "week");
    addFormatToken("W", ["WW", 2], "Wo", "isoWeek");
    addRegexToken("w", match1to2, match1to2NoLeadingZero);
    addRegexToken("ww", match1to2, match2);
    addRegexToken("W", match1to2, match1to2NoLeadingZero);
    addRegexToken("WW", match1to2, match2);
    addWeekParseToken(["w", "ww", "W", "WW"], function(input, week, config, token2) {
      week[token2.substr(0, 1)] = toInt(input);
    });
    function localeWeek(mom) {
      return weekOfYear(mom, this._week.dow, this._week.doy).week;
    }
    var defaultLocaleWeek = {
      dow: 0,
      doy: 6
    };
    function localeFirstDayOfWeek() {
      return this._week.dow;
    }
    function localeFirstDayOfYear() {
      return this._week.doy;
    }
    function getSetWeek(input) {
      var week = this.localeData().week(this);
      return input == null ? week : this.add((input - week) * 7, "d");
    }
    function getSetISOWeek(input) {
      var week = weekOfYear(this, 1, 4).week;
      return input == null ? week : this.add((input - week) * 7, "d");
    }
    addFormatToken("d", 0, "do", "day");
    addFormatToken("dd", 0, 0, function(format2) {
      return this.localeData().weekdaysMin(this, format2);
    });
    addFormatToken("ddd", 0, 0, function(format2) {
      return this.localeData().weekdaysShort(this, format2);
    });
    addFormatToken("dddd", 0, 0, function(format2) {
      return this.localeData().weekdays(this, format2);
    });
    addFormatToken("e", 0, 0, "weekday");
    addFormatToken("E", 0, 0, "isoWeekday");
    addRegexToken("d", match1to2);
    addRegexToken("e", match1to2);
    addRegexToken("E", match1to2);
    addRegexToken("dd", function(isStrict, locale2) {
      return locale2.weekdaysMinRegex(isStrict);
    });
    addRegexToken("ddd", function(isStrict, locale2) {
      return locale2.weekdaysShortRegex(isStrict);
    });
    addRegexToken("dddd", function(isStrict, locale2) {
      return locale2.weekdaysRegex(isStrict);
    });
    addWeekParseToken(["dd", "ddd", "dddd"], function(input, week, config, token2) {
      var weekday = config._locale.weekdaysParse(input, token2, config._strict);
      if (weekday != null) {
        week.d = weekday;
      } else {
        getParsingFlags(config).invalidWeekday = input;
      }
    });
    addWeekParseToken(["d", "e", "E"], function(input, week, config, token2) {
      week[token2] = toInt(input);
    });
    function parseWeekday(input, locale2) {
      if (typeof input !== "string") {
        return input;
      }
      if (!isNaN(input)) {
        return parseInt(input, 10);
      }
      input = locale2.weekdaysParse(input);
      if (typeof input === "number") {
        return input;
      }
      return null;
    }
    function parseIsoWeekday(input, locale2) {
      if (typeof input === "string") {
        return locale2.weekdaysParse(input) % 7 || 7;
      }
      return isNaN(input) ? null : input;
    }
    function shiftWeekdays(ws, n) {
      return ws.slice(n, 7).concat(ws.slice(0, n));
    }
    var defaultLocaleWeekdays = "Sunday_Monday_Tuesday_Wednesday_Thursday_Friday_Saturday".split("_"), defaultLocaleWeekdaysShort = "Sun_Mon_Tue_Wed_Thu_Fri_Sat".split("_"), defaultLocaleWeekdaysMin = "Su_Mo_Tu_We_Th_Fr_Sa".split("_"), defaultWeekdaysRegex = matchWord, defaultWeekdaysShortRegex = matchWord, defaultWeekdaysMinRegex = matchWord;
    function localeWeekdays(m, format2) {
      var weekdays = isArray(this._weekdays) ? this._weekdays : this._weekdays[m && m !== true && this._weekdays.isFormat.test(format2) ? "format" : "standalone"];
      return m === true ? shiftWeekdays(weekdays, this._week.dow) : m ? weekdays[m.day()] : weekdays;
    }
    function localeWeekdaysShort(m) {
      return m === true ? shiftWeekdays(this._weekdaysShort, this._week.dow) : m ? this._weekdaysShort[m.day()] : this._weekdaysShort;
    }
    function localeWeekdaysMin(m) {
      return m === true ? shiftWeekdays(this._weekdaysMin, this._week.dow) : m ? this._weekdaysMin[m.day()] : this._weekdaysMin;
    }
    function handleStrictParse$1(weekdayName, format2, strict) {
      var i, ii, mom, llc = weekdayName.toLocaleLowerCase();
      if (!this._weekdaysParse) {
        this._weekdaysParse = [];
        this._shortWeekdaysParse = [];
        this._minWeekdaysParse = [];
        for (i = 0;i < 7; ++i) {
          mom = createUTC([2000, 1]).day(i);
          this._minWeekdaysParse[i] = this.weekdaysMin(mom, "").toLocaleLowerCase();
          this._shortWeekdaysParse[i] = this.weekdaysShort(mom, "").toLocaleLowerCase();
          this._weekdaysParse[i] = this.weekdays(mom, "").toLocaleLowerCase();
        }
      }
      if (strict) {
        if (format2 === "dddd") {
          ii = indexOf.call(this._weekdaysParse, llc);
          return ii !== -1 ? ii : null;
        } else if (format2 === "ddd") {
          ii = indexOf.call(this._shortWeekdaysParse, llc);
          return ii !== -1 ? ii : null;
        } else {
          ii = indexOf.call(this._minWeekdaysParse, llc);
          return ii !== -1 ? ii : null;
        }
      } else {
        if (format2 === "dddd") {
          ii = indexOf.call(this._weekdaysParse, llc);
          if (ii !== -1) {
            return ii;
          }
          ii = indexOf.call(this._shortWeekdaysParse, llc);
          if (ii !== -1) {
            return ii;
          }
          ii = indexOf.call(this._minWeekdaysParse, llc);
          return ii !== -1 ? ii : null;
        } else if (format2 === "ddd") {
          ii = indexOf.call(this._shortWeekdaysParse, llc);
          if (ii !== -1) {
            return ii;
          }
          ii = indexOf.call(this._weekdaysParse, llc);
          if (ii !== -1) {
            return ii;
          }
          ii = indexOf.call(this._minWeekdaysParse, llc);
          return ii !== -1 ? ii : null;
        } else {
          ii = indexOf.call(this._minWeekdaysParse, llc);
          if (ii !== -1) {
            return ii;
          }
          ii = indexOf.call(this._weekdaysParse, llc);
          if (ii !== -1) {
            return ii;
          }
          ii = indexOf.call(this._shortWeekdaysParse, llc);
          return ii !== -1 ? ii : null;
        }
      }
    }
    function localeWeekdaysParse(weekdayName, format2, strict) {
      var i, mom, regex;
      if (this._weekdaysParseExact) {
        return handleStrictParse$1.call(this, weekdayName, format2, strict);
      }
      if (!this._weekdaysParse) {
        this._weekdaysParse = [];
        this._minWeekdaysParse = [];
        this._shortWeekdaysParse = [];
        this._fullWeekdaysParse = [];
      }
      for (i = 0;i < 7; i++) {
        mom = createUTC([2000, 1]).day(i);
        if (strict && !this._fullWeekdaysParse[i]) {
          this._fullWeekdaysParse[i] = new RegExp("^" + this.weekdays(mom, "").replace(".", "\\.?") + "$", "i");
          this._shortWeekdaysParse[i] = new RegExp("^" + this.weekdaysShort(mom, "").replace(".", "\\.?") + "$", "i");
          this._minWeekdaysParse[i] = new RegExp("^" + this.weekdaysMin(mom, "").replace(".", "\\.?") + "$", "i");
        }
        if (!this._weekdaysParse[i]) {
          regex = "^" + this.weekdays(mom, "") + "|^" + this.weekdaysShort(mom, "") + "|^" + this.weekdaysMin(mom, "");
          this._weekdaysParse[i] = new RegExp(regex.replace(".", ""), "i");
        }
        if (strict && format2 === "dddd" && this._fullWeekdaysParse[i].test(weekdayName)) {
          return i;
        } else if (strict && format2 === "ddd" && this._shortWeekdaysParse[i].test(weekdayName)) {
          return i;
        } else if (strict && format2 === "dd" && this._minWeekdaysParse[i].test(weekdayName)) {
          return i;
        } else if (!strict && this._weekdaysParse[i].test(weekdayName)) {
          return i;
        }
      }
    }
    function getSetDayOfWeek(input) {
      if (!this.isValid()) {
        return input != null ? this : NaN;
      }
      var day = get(this, "Day");
      if (input != null) {
        input = parseWeekday(input, this.localeData());
        return this.add(input - day, "d");
      } else {
        return day;
      }
    }
    function getSetLocaleDayOfWeek(input) {
      if (!this.isValid()) {
        return input != null ? this : NaN;
      }
      var weekday = (this.day() + 7 - this.localeData()._week.dow) % 7;
      return input == null ? weekday : this.add(input - weekday, "d");
    }
    function getSetISODayOfWeek(input) {
      if (!this.isValid()) {
        return input != null ? this : NaN;
      }
      if (input != null) {
        var weekday = parseIsoWeekday(input, this.localeData());
        return this.day(this.day() % 7 ? weekday : weekday - 7);
      } else {
        return this.day() || 7;
      }
    }
    function weekdaysRegex(isStrict) {
      if (this._weekdaysParseExact) {
        if (!hasOwnProp(this, "_weekdaysRegex")) {
          computeWeekdaysParse.call(this);
        }
        if (isStrict) {
          return this._weekdaysStrictRegex;
        } else {
          return this._weekdaysRegex;
        }
      } else {
        if (!hasOwnProp(this, "_weekdaysRegex")) {
          this._weekdaysRegex = defaultWeekdaysRegex;
        }
        return this._weekdaysStrictRegex && isStrict ? this._weekdaysStrictRegex : this._weekdaysRegex;
      }
    }
    function weekdaysShortRegex(isStrict) {
      if (this._weekdaysParseExact) {
        if (!hasOwnProp(this, "_weekdaysRegex")) {
          computeWeekdaysParse.call(this);
        }
        if (isStrict) {
          return this._weekdaysShortStrictRegex;
        } else {
          return this._weekdaysShortRegex;
        }
      } else {
        if (!hasOwnProp(this, "_weekdaysShortRegex")) {
          this._weekdaysShortRegex = defaultWeekdaysShortRegex;
        }
        return this._weekdaysShortStrictRegex && isStrict ? this._weekdaysShortStrictRegex : this._weekdaysShortRegex;
      }
    }
    function weekdaysMinRegex(isStrict) {
      if (this._weekdaysParseExact) {
        if (!hasOwnProp(this, "_weekdaysRegex")) {
          computeWeekdaysParse.call(this);
        }
        if (isStrict) {
          return this._weekdaysMinStrictRegex;
        } else {
          return this._weekdaysMinRegex;
        }
      } else {
        if (!hasOwnProp(this, "_weekdaysMinRegex")) {
          this._weekdaysMinRegex = defaultWeekdaysMinRegex;
        }
        return this._weekdaysMinStrictRegex && isStrict ? this._weekdaysMinStrictRegex : this._weekdaysMinRegex;
      }
    }
    function computeWeekdaysParse() {
      function cmpLenRev(a, b) {
        return b.length - a.length;
      }
      var minPieces = [], shortPieces = [], longPieces = [], mixedPieces = [], i, mom, minp, shortp, longp;
      for (i = 0;i < 7; i++) {
        mom = createUTC([2000, 1]).day(i);
        minp = regexEscape(this.weekdaysMin(mom, ""));
        shortp = regexEscape(this.weekdaysShort(mom, ""));
        longp = regexEscape(this.weekdays(mom, ""));
        minPieces.push(minp);
        shortPieces.push(shortp);
        longPieces.push(longp);
        mixedPieces.push(minp);
        mixedPieces.push(shortp);
        mixedPieces.push(longp);
      }
      minPieces.sort(cmpLenRev);
      shortPieces.sort(cmpLenRev);
      longPieces.sort(cmpLenRev);
      mixedPieces.sort(cmpLenRev);
      this._weekdaysRegex = new RegExp("^(" + mixedPieces.join("|") + ")", "i");
      this._weekdaysShortRegex = this._weekdaysRegex;
      this._weekdaysMinRegex = this._weekdaysRegex;
      this._weekdaysStrictRegex = new RegExp("^(" + longPieces.join("|") + ")", "i");
      this._weekdaysShortStrictRegex = new RegExp("^(" + shortPieces.join("|") + ")", "i");
      this._weekdaysMinStrictRegex = new RegExp("^(" + minPieces.join("|") + ")", "i");
    }
    function hFormat() {
      return this.hours() % 12 || 12;
    }
    function kFormat() {
      return this.hours() || 24;
    }
    addFormatToken("H", ["HH", 2], 0, "hour");
    addFormatToken("h", ["hh", 2], 0, hFormat);
    addFormatToken("k", ["kk", 2], 0, kFormat);
    addFormatToken("hmm", 0, 0, function() {
      return "" + hFormat.apply(this) + zeroFill(this.minutes(), 2);
    });
    addFormatToken("hmmss", 0, 0, function() {
      return "" + hFormat.apply(this) + zeroFill(this.minutes(), 2) + zeroFill(this.seconds(), 2);
    });
    addFormatToken("Hmm", 0, 0, function() {
      return "" + this.hours() + zeroFill(this.minutes(), 2);
    });
    addFormatToken("Hmmss", 0, 0, function() {
      return "" + this.hours() + zeroFill(this.minutes(), 2) + zeroFill(this.seconds(), 2);
    });
    function meridiem(token2, lowercase) {
      addFormatToken(token2, 0, 0, function() {
        return this.localeData().meridiem(this.hours(), this.minutes(), lowercase);
      });
    }
    meridiem("a", true);
    meridiem("A", false);
    function matchMeridiem(isStrict, locale2) {
      return locale2._meridiemParse;
    }
    addRegexToken("a", matchMeridiem);
    addRegexToken("A", matchMeridiem);
    addRegexToken("H", match1to2, match1to2HasZero);
    addRegexToken("h", match1to2, match1to2NoLeadingZero);
    addRegexToken("k", match1to2, match1to2NoLeadingZero);
    addRegexToken("HH", match1to2, match2);
    addRegexToken("hh", match1to2, match2);
    addRegexToken("kk", match1to2, match2);
    addRegexToken("hmm", match3to4);
    addRegexToken("hmmss", match5to6);
    addRegexToken("Hmm", match3to4);
    addRegexToken("Hmmss", match5to6);
    addParseToken(["H", "HH"], HOUR);
    addParseToken(["k", "kk"], function(input, array, config) {
      var kInput = toInt(input);
      array[HOUR] = kInput === 24 ? 0 : kInput;
    });
    addParseToken(["a", "A"], function(input, array, config) {
      config._isPm = config._locale.isPM(input);
      config._meridiem = input;
    });
    addParseToken(["h", "hh"], function(input, array, config) {
      array[HOUR] = toInt(input);
      getParsingFlags(config).bigHour = true;
    });
    addParseToken("hmm", function(input, array, config) {
      var pos = input.length - 2;
      array[HOUR] = toInt(input.substr(0, pos));
      array[MINUTE] = toInt(input.substr(pos));
      getParsingFlags(config).bigHour = true;
    });
    addParseToken("hmmss", function(input, array, config) {
      var pos1 = input.length - 4, pos2 = input.length - 2;
      array[HOUR] = toInt(input.substr(0, pos1));
      array[MINUTE] = toInt(input.substr(pos1, 2));
      array[SECOND] = toInt(input.substr(pos2));
      getParsingFlags(config).bigHour = true;
    });
    addParseToken("Hmm", function(input, array, config) {
      var pos = input.length - 2;
      array[HOUR] = toInt(input.substr(0, pos));
      array[MINUTE] = toInt(input.substr(pos));
    });
    addParseToken("Hmmss", function(input, array, config) {
      var pos1 = input.length - 4, pos2 = input.length - 2;
      array[HOUR] = toInt(input.substr(0, pos1));
      array[MINUTE] = toInt(input.substr(pos1, 2));
      array[SECOND] = toInt(input.substr(pos2));
    });
    function localeIsPM(input) {
      return (input + "").toLowerCase().charAt(0) === "p";
    }
    var defaultLocaleMeridiemParse = /[ap]\.?m?\.?/i, getSetHour = makeGetSet("Hours", true);
    function localeMeridiem(hours2, minutes2, isLower) {
      if (hours2 > 11) {
        return isLower ? "pm" : "PM";
      } else {
        return isLower ? "am" : "AM";
      }
    }
    var baseConfig = {
      calendar: defaultCalendar,
      longDateFormat: defaultLongDateFormat,
      invalidDate: defaultInvalidDate,
      ordinal: defaultOrdinal,
      dayOfMonthOrdinalParse: defaultDayOfMonthOrdinalParse,
      relativeTime: defaultRelativeTime,
      months: defaultLocaleMonths,
      monthsShort: defaultLocaleMonthsShort,
      week: defaultLocaleWeek,
      weekdays: defaultLocaleWeekdays,
      weekdaysMin: defaultLocaleWeekdaysMin,
      weekdaysShort: defaultLocaleWeekdaysShort,
      meridiemParse: defaultLocaleMeridiemParse
    };
    var locales = {}, localeFamilies = {}, globalLocale;
    function commonPrefix(arr1, arr2) {
      var i, minl = Math.min(arr1.length, arr2.length);
      for (i = 0;i < minl; i += 1) {
        if (arr1[i] !== arr2[i]) {
          return i;
        }
      }
      return minl;
    }
    function normalizeLocale(key) {
      return key ? key.toLowerCase().replace("_", "-") : key;
    }
    function chooseLocale(names) {
      var i = 0, j, next, locale2, split;
      while (i < names.length) {
        split = normalizeLocale(names[i]).split("-");
        j = split.length;
        next = normalizeLocale(names[i + 1]);
        next = next ? next.split("-") : null;
        while (j > 0) {
          locale2 = loadLocale(split.slice(0, j).join("-"));
          if (locale2) {
            return locale2;
          }
          if (next && next.length >= j && commonPrefix(split, next) >= j - 1) {
            break;
          }
          j--;
        }
        i++;
      }
      return globalLocale;
    }
    function isLocaleNameSane(name) {
      return !!(name && name.match("^[^/\\\\]*$"));
    }
    function loadLocale(name) {
      var oldLocale = null, aliasedRequire;
      if (locales[name] === undefined && typeof module !== "undefined" && module && module.exports && isLocaleNameSane(name)) {
        try {
          oldLocale = globalLocale._abbr;
          aliasedRequire = __require;
          aliasedRequire("./locale/" + name);
          getSetGlobalLocale(oldLocale);
        } catch (e) {
          locales[name] = null;
        }
      }
      return locales[name];
    }
    function getSetGlobalLocale(key, values) {
      var data;
      if (key) {
        if (isUndefined(values)) {
          data = getLocale(key);
        } else {
          data = defineLocale(key, values);
        }
        if (data) {
          globalLocale = data;
        } else {
          if (typeof console !== "undefined" && console.warn) {
            console.warn("Locale " + key + " not found. Did you forget to load it?");
          }
        }
      }
      return globalLocale._abbr;
    }
    function defineLocale(name, config) {
      if (config !== null) {
        var locale2, parentConfig = baseConfig;
        config.abbr = name;
        if (locales[name] != null) {
          deprecateSimple("defineLocaleOverride", "use moment.updateLocale(localeName, config) to change " + "an existing locale. moment.defineLocale(localeName, " + "config) should only be used for creating a new locale " + "See http://momentjs.com/guides/#/warnings/define-locale/ for more info.");
          parentConfig = locales[name]._config;
        } else if (config.parentLocale != null) {
          if (locales[config.parentLocale] != null) {
            parentConfig = locales[config.parentLocale]._config;
          } else {
            locale2 = loadLocale(config.parentLocale);
            if (locale2 != null) {
              parentConfig = locale2._config;
            } else {
              if (!localeFamilies[config.parentLocale]) {
                localeFamilies[config.parentLocale] = [];
              }
              localeFamilies[config.parentLocale].push({
                name,
                config
              });
              return null;
            }
          }
        }
        locales[name] = new Locale(mergeConfigs(parentConfig, config));
        if (localeFamilies[name]) {
          localeFamilies[name].forEach(function(x) {
            defineLocale(x.name, x.config);
          });
        }
        getSetGlobalLocale(name);
        return locales[name];
      } else {
        delete locales[name];
        return null;
      }
    }
    function updateLocale(name, config) {
      if (config != null) {
        var locale2, tmpLocale, parentConfig = baseConfig;
        if (locales[name] != null && locales[name].parentLocale != null) {
          locales[name].set(mergeConfigs(locales[name]._config, config));
        } else {
          tmpLocale = loadLocale(name);
          if (tmpLocale != null) {
            parentConfig = tmpLocale._config;
          }
          config = mergeConfigs(parentConfig, config);
          if (tmpLocale == null) {
            config.abbr = name;
          }
          locale2 = new Locale(config);
          locale2.parentLocale = locales[name];
          locales[name] = locale2;
        }
        getSetGlobalLocale(name);
      } else {
        if (locales[name] != null) {
          if (locales[name].parentLocale != null) {
            locales[name] = locales[name].parentLocale;
            if (name === getSetGlobalLocale()) {
              getSetGlobalLocale(name);
            }
          } else if (locales[name] != null) {
            delete locales[name];
          }
        }
      }
      return locales[name];
    }
    function getLocale(key) {
      var locale2;
      if (key && key._locale && key._locale._abbr) {
        key = key._locale._abbr;
      }
      if (!key) {
        return globalLocale;
      }
      if (!isArray(key)) {
        locale2 = loadLocale(key);
        if (locale2) {
          return locale2;
        }
        key = [key];
      }
      return chooseLocale(key);
    }
    function listLocales() {
      return keys(locales);
    }
    function checkOverflow(m) {
      var overflow, a = m._a;
      if (a && getParsingFlags(m).overflow === -2) {
        overflow = a[MONTH] < 0 || a[MONTH] > 11 ? MONTH : a[DATE] < 1 || a[DATE] > daysInMonth(a[YEAR], a[MONTH]) ? DATE : a[HOUR] < 0 || a[HOUR] > 24 || a[HOUR] === 24 && (a[MINUTE] !== 0 || a[SECOND] !== 0 || a[MILLISECOND] !== 0) ? HOUR : a[MINUTE] < 0 || a[MINUTE] > 59 ? MINUTE : a[SECOND] < 0 || a[SECOND] > 59 ? SECOND : a[MILLISECOND] < 0 || a[MILLISECOND] > 999 ? MILLISECOND : -1;
        if (getParsingFlags(m)._overflowDayOfYear && (overflow < YEAR || overflow > DATE)) {
          overflow = DATE;
        }
        if (getParsingFlags(m)._overflowWeeks && overflow === -1) {
          overflow = WEEK;
        }
        if (getParsingFlags(m)._overflowWeekday && overflow === -1) {
          overflow = WEEKDAY;
        }
        getParsingFlags(m).overflow = overflow;
      }
      return m;
    }
    var extendedIsoRegex = /^\s*((?:[+-]\d{6}|\d{4})-(?:\d\d-\d\d|W\d\d-\d|W\d\d|\d\d\d|\d\d))(?:(T| )(\d\d(?::\d\d(?::\d\d(?:[.,]\d+)?)?)?)([+-]\d\d(?::?\d\d)?|\s*Z)?)?$/, basicIsoRegex = /^\s*((?:[+-]\d{6}|\d{4})(?:\d\d\d\d|W\d\d\d|W\d\d|\d\d\d|\d\d|))(?:(T| )(\d\d(?:\d\d(?:\d\d(?:[.,]\d+)?)?)?)([+-]\d\d(?::?\d\d)?|\s*Z)?)?$/, tzRegex = /Z|[+-]\d\d(?::?\d\d)?/, isoDates = [
      ["YYYYYY-MM-DD", /[+-]\d{6}-\d\d-\d\d/],
      ["YYYY-MM-DD", /\d{4}-\d\d-\d\d/],
      ["GGGG-[W]WW-E", /\d{4}-W\d\d-\d/],
      ["GGGG-[W]WW", /\d{4}-W\d\d/, false],
      ["YYYY-DDD", /\d{4}-\d{3}/],
      ["YYYY-MM", /\d{4}-\d\d/, false],
      ["YYYYYYMMDD", /[+-]\d{10}/],
      ["YYYYMMDD", /\d{8}/],
      ["GGGG[W]WWE", /\d{4}W\d{3}/],
      ["GGGG[W]WW", /\d{4}W\d{2}/, false],
      ["YYYYDDD", /\d{7}/],
      ["YYYYMM", /\d{6}/, false],
      ["YYYY", /\d{4}/, false]
    ], isoTimes = [
      ["HH:mm:ss.SSSS", /\d\d:\d\d:\d\d\.\d+/],
      ["HH:mm:ss,SSSS", /\d\d:\d\d:\d\d,\d+/],
      ["HH:mm:ss", /\d\d:\d\d:\d\d/],
      ["HH:mm", /\d\d:\d\d/],
      ["HHmmss.SSSS", /\d\d\d\d\d\d\.\d+/],
      ["HHmmss,SSSS", /\d\d\d\d\d\d,\d+/],
      ["HHmmss", /\d\d\d\d\d\d/],
      ["HHmm", /\d\d\d\d/],
      ["HH", /\d\d/]
    ], aspNetJsonRegex = /^\/?Date\((-?\d+)/i, rfc2822 = /^(?:(Mon|Tue|Wed|Thu|Fri|Sat|Sun),?\s)?(\d{1,2})\s(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s(\d{2,4})\s(\d\d):(\d\d)(?::(\d\d))?\s(?:(UT|GMT|[ECMP][SD]T)|([Zz])|([+-]\d{4}))$/, obsOffsets = {
      UT: 0,
      GMT: 0,
      EDT: -4 * 60,
      EST: -5 * 60,
      CDT: -5 * 60,
      CST: -6 * 60,
      MDT: -6 * 60,
      MST: -7 * 60,
      PDT: -7 * 60,
      PST: -8 * 60
    };
    function configFromISO(config) {
      var i, l, string = config._i, match = extendedIsoRegex.exec(string) || basicIsoRegex.exec(string), allowTime, dateFormat, timeFormat, tzFormat, isoDatesLen = isoDates.length, isoTimesLen = isoTimes.length;
      if (match) {
        getParsingFlags(config).iso = true;
        for (i = 0, l = isoDatesLen;i < l; i++) {
          if (isoDates[i][1].exec(match[1])) {
            dateFormat = isoDates[i][0];
            allowTime = isoDates[i][2] !== false;
            break;
          }
        }
        if (dateFormat == null) {
          config._isValid = false;
          return;
        }
        if (match[3]) {
          for (i = 0, l = isoTimesLen;i < l; i++) {
            if (isoTimes[i][1].exec(match[3])) {
              timeFormat = (match[2] || " ") + isoTimes[i][0];
              break;
            }
          }
          if (timeFormat == null) {
            config._isValid = false;
            return;
          }
        }
        if (!allowTime && timeFormat != null) {
          config._isValid = false;
          return;
        }
        if (match[4]) {
          if (tzRegex.exec(match[4])) {
            tzFormat = "Z";
          } else {
            config._isValid = false;
            return;
          }
        }
        config._f = dateFormat + (timeFormat || "") + (tzFormat || "");
        configFromStringAndFormat(config);
      } else {
        config._isValid = false;
      }
    }
    function extractFromRFC2822Strings(yearStr, monthStr, dayStr, hourStr, minuteStr, secondStr) {
      var result = [
        untruncateYear(yearStr),
        defaultLocaleMonthsShort.indexOf(monthStr),
        parseInt(dayStr, 10),
        parseInt(hourStr, 10),
        parseInt(minuteStr, 10)
      ];
      if (secondStr) {
        result.push(parseInt(secondStr, 10));
      }
      return result;
    }
    function untruncateYear(yearStr) {
      var year = parseInt(yearStr, 10);
      if (year <= 49) {
        return 2000 + year;
      } else if (year <= 999) {
        return 1900 + year;
      }
      return year;
    }
    function preprocessRFC2822(s) {
      return s.replace(/\([^()]*\)|[\n\t]/g, " ").replace(/(\s\s+)/g, " ").replace(/^\s\s*/, "").replace(/\s\s*$/, "");
    }
    function checkWeekday(weekdayStr, parsedInput, config) {
      if (weekdayStr) {
        var weekdayProvided = defaultLocaleWeekdaysShort.indexOf(weekdayStr), weekdayActual = new Date(parsedInput[0], parsedInput[1], parsedInput[2]).getDay();
        if (weekdayProvided !== weekdayActual) {
          getParsingFlags(config).weekdayMismatch = true;
          config._isValid = false;
          return false;
        }
      }
      return true;
    }
    function calculateOffset(obsOffset, militaryOffset, numOffset) {
      if (obsOffset) {
        return obsOffsets[obsOffset];
      } else if (militaryOffset) {
        return 0;
      } else {
        var hm = parseInt(numOffset, 10), m = hm % 100, h = (hm - m) / 100;
        return h * 60 + m;
      }
    }
    function configFromRFC2822(config) {
      var match = rfc2822.exec(preprocessRFC2822(config._i)), parsedArray;
      if (match) {
        parsedArray = extractFromRFC2822Strings(match[4], match[3], match[2], match[5], match[6], match[7]);
        if (!checkWeekday(match[1], parsedArray, config)) {
          return;
        }
        config._a = parsedArray;
        config._tzm = calculateOffset(match[8], match[9], match[10]);
        config._d = createUTCDate.apply(null, config._a);
        config._d.setUTCMinutes(config._d.getUTCMinutes() - config._tzm);
        getParsingFlags(config).rfc2822 = true;
      } else {
        config._isValid = false;
      }
    }
    function configFromString(config) {
      var matched = aspNetJsonRegex.exec(config._i);
      if (matched !== null) {
        config._d = new Date(+matched[1]);
        return;
      }
      configFromISO(config);
      if (config._isValid === false) {
        delete config._isValid;
      } else {
        return;
      }
      configFromRFC2822(config);
      if (config._isValid === false) {
        delete config._isValid;
      } else {
        return;
      }
      if (config._strict) {
        config._isValid = false;
      } else {
        hooks.createFromInputFallback(config);
      }
    }
    hooks.createFromInputFallback = deprecate("value provided is not in a recognized RFC2822 or ISO format. moment construction falls back to js Date(), " + "which is not reliable across all browsers and versions. Non RFC2822/ISO date formats are " + "discouraged. Please refer to http://momentjs.com/guides/#/warnings/js-date/ for more info.", function(config) {
      config._d = new Date(config._i + (config._useUTC ? " UTC" : ""));
    });
    function defaults(a, b, c) {
      if (a != null) {
        return a;
      }
      if (b != null) {
        return b;
      }
      return c;
    }
    function currentDateArray(config) {
      var nowValue = new Date(hooks.now());
      if (config._useUTC) {
        return [
          nowValue.getUTCFullYear(),
          nowValue.getUTCMonth(),
          nowValue.getUTCDate()
        ];
      }
      return [nowValue.getFullYear(), nowValue.getMonth(), nowValue.getDate()];
    }
    function configFromArray(config) {
      var i, date, input = [], currentDate, expectedWeekday, yearToUse;
      if (config._d) {
        return;
      }
      currentDate = currentDateArray(config);
      if (config._w && config._a[DATE] == null && config._a[MONTH] == null) {
        dayOfYearFromWeekInfo(config);
      }
      if (config._dayOfYear != null) {
        yearToUse = defaults(config._a[YEAR], currentDate[YEAR]);
        if (config._dayOfYear > daysInYear(yearToUse) || config._dayOfYear === 0) {
          getParsingFlags(config)._overflowDayOfYear = true;
        }
        date = createUTCDate(yearToUse, 0, config._dayOfYear);
        config._a[MONTH] = date.getUTCMonth();
        config._a[DATE] = date.getUTCDate();
      }
      for (i = 0;i < 3 && config._a[i] == null; ++i) {
        config._a[i] = input[i] = currentDate[i];
      }
      for (;i < 7; i++) {
        config._a[i] = input[i] = config._a[i] == null ? i === 2 ? 1 : 0 : config._a[i];
      }
      if (config._a[HOUR] === 24 && config._a[MINUTE] === 0 && config._a[SECOND] === 0 && config._a[MILLISECOND] === 0) {
        config._nextDay = true;
        config._a[HOUR] = 0;
      }
      config._d = (config._useUTC ? createUTCDate : createDate).apply(null, input);
      expectedWeekday = config._useUTC ? config._d.getUTCDay() : config._d.getDay();
      if (config._tzm != null) {
        config._d.setUTCMinutes(config._d.getUTCMinutes() - config._tzm);
      }
      if (config._nextDay) {
        config._a[HOUR] = 24;
      }
      if (config._w && typeof config._w.d !== "undefined" && config._w.d !== expectedWeekday) {
        getParsingFlags(config).weekdayMismatch = true;
      }
    }
    function dayOfYearFromWeekInfo(config) {
      var w, weekYear, week, weekday, dow, doy, temp, weekdayOverflow, curWeek;
      w = config._w;
      if (w.GG != null || w.W != null || w.E != null) {
        dow = 1;
        doy = 4;
        weekYear = defaults(w.GG, config._a[YEAR], weekOfYear(createLocal(), 1, 4).year);
        week = defaults(w.W, 1);
        weekday = defaults(w.E, 1);
        if (weekday < 1 || weekday > 7) {
          weekdayOverflow = true;
        }
      } else {
        dow = config._locale._week.dow;
        doy = config._locale._week.doy;
        curWeek = weekOfYear(createLocal(), dow, doy);
        weekYear = defaults(w.gg, config._a[YEAR], curWeek.year);
        week = defaults(w.w, curWeek.week);
        if (w.d != null) {
          weekday = w.d;
          if (weekday < 0 || weekday > 6) {
            weekdayOverflow = true;
          }
        } else if (w.e != null) {
          weekday = w.e + dow;
          if (w.e < 0 || w.e > 6) {
            weekdayOverflow = true;
          }
        } else {
          weekday = dow;
        }
      }
      if (week < 1 || week > weeksInYear(weekYear, dow, doy)) {
        getParsingFlags(config)._overflowWeeks = true;
      } else if (weekdayOverflow != null) {
        getParsingFlags(config)._overflowWeekday = true;
      } else {
        temp = dayOfYearFromWeeks(weekYear, week, weekday, dow, doy);
        config._a[YEAR] = temp.year;
        config._dayOfYear = temp.dayOfYear;
      }
    }
    hooks.ISO_8601 = function() {};
    hooks.RFC_2822 = function() {};
    function configFromStringAndFormat(config) {
      if (config._f === hooks.ISO_8601) {
        configFromISO(config);
        return;
      }
      if (config._f === hooks.RFC_2822) {
        configFromRFC2822(config);
        return;
      }
      config._a = [];
      getParsingFlags(config).empty = true;
      var string = "" + config._i, i, parsedInput, tokens2, token2, skipped, stringLength = string.length, totalParsedInputLength = 0, era, tokenLen;
      tokens2 = expandFormat(config._f, config._locale).match(formattingTokens) || [];
      tokenLen = tokens2.length;
      for (i = 0;i < tokenLen; i++) {
        token2 = tokens2[i];
        parsedInput = (string.match(getParseRegexForToken(token2, config)) || [])[0];
        if (parsedInput) {
          skipped = string.substr(0, string.indexOf(parsedInput));
          if (skipped.length > 0) {
            getParsingFlags(config).unusedInput.push(skipped);
          }
          string = string.slice(string.indexOf(parsedInput) + parsedInput.length);
          totalParsedInputLength += parsedInput.length;
        }
        if (formatTokenFunctions[token2]) {
          if (parsedInput) {
            getParsingFlags(config).empty = false;
          } else {
            getParsingFlags(config).unusedTokens.push(token2);
          }
          addTimeToArrayFromToken(token2, parsedInput, config);
        } else if (config._strict && !parsedInput) {
          getParsingFlags(config).unusedTokens.push(token2);
        }
      }
      getParsingFlags(config).charsLeftOver = stringLength - totalParsedInputLength;
      if (string.length > 0) {
        getParsingFlags(config).unusedInput.push(string);
      }
      if (config._a[HOUR] <= 12 && getParsingFlags(config).bigHour === true && config._a[HOUR] > 0) {
        getParsingFlags(config).bigHour = undefined;
      }
      getParsingFlags(config).parsedDateParts = config._a.slice(0);
      getParsingFlags(config).meridiem = config._meridiem;
      config._a[HOUR] = meridiemFixWrap(config._locale, config._a[HOUR], config._meridiem);
      era = getParsingFlags(config).era;
      if (era !== null) {
        config._a[YEAR] = config._locale.erasConvertYear(era, config._a[YEAR]);
      }
      configFromArray(config);
      checkOverflow(config);
    }
    function meridiemFixWrap(locale2, hour, meridiem2) {
      var isPm;
      if (meridiem2 == null) {
        return hour;
      }
      if (locale2.meridiemHour != null) {
        return locale2.meridiemHour(hour, meridiem2);
      } else if (locale2.isPM != null) {
        isPm = locale2.isPM(meridiem2);
        if (isPm && hour < 12) {
          hour += 12;
        }
        if (!isPm && hour === 12) {
          hour = 0;
        }
        return hour;
      } else {
        return hour;
      }
    }
    function configFromStringAndArray(config) {
      var tempConfig, bestMoment, scoreToBeat, i, currentScore, validFormatFound, bestFormatIsValid = false, configfLen = config._f.length;
      if (configfLen === 0) {
        getParsingFlags(config).invalidFormat = true;
        config._d = new Date(NaN);
        return;
      }
      for (i = 0;i < configfLen; i++) {
        currentScore = 0;
        validFormatFound = false;
        tempConfig = copyConfig({}, config);
        if (config._useUTC != null) {
          tempConfig._useUTC = config._useUTC;
        }
        tempConfig._f = config._f[i];
        configFromStringAndFormat(tempConfig);
        if (isValid(tempConfig)) {
          validFormatFound = true;
        }
        currentScore += getParsingFlags(tempConfig).charsLeftOver;
        currentScore += getParsingFlags(tempConfig).unusedTokens.length * 10;
        getParsingFlags(tempConfig).score = currentScore;
        if (!bestFormatIsValid) {
          if (scoreToBeat == null || currentScore < scoreToBeat || validFormatFound) {
            scoreToBeat = currentScore;
            bestMoment = tempConfig;
            if (validFormatFound) {
              bestFormatIsValid = true;
            }
          }
        } else {
          if (currentScore < scoreToBeat) {
            scoreToBeat = currentScore;
            bestMoment = tempConfig;
          }
        }
      }
      extend(config, bestMoment || tempConfig);
    }
    function configFromObject(config) {
      if (config._d) {
        return;
      }
      var i = normalizeObjectUnits(config._i), dayOrDate = i.day === undefined ? i.date : i.day;
      config._a = map([i.year, i.month, dayOrDate, i.hour, i.minute, i.second, i.millisecond], function(obj) {
        return obj && parseInt(obj, 10);
      });
      configFromArray(config);
    }
    function createFromConfig(config) {
      var res = new Moment(checkOverflow(prepareConfig(config)));
      if (res._nextDay) {
        res.add(1, "d");
        res._nextDay = undefined;
      }
      return res;
    }
    function prepareConfig(config) {
      var { _i: input, _f: format2 } = config;
      config._locale = config._locale || getLocale(config._l);
      if (input === null || format2 === undefined && input === "") {
        return createInvalid({ nullInput: true });
      }
      if (typeof input === "string") {
        config._i = input = config._locale.preparse(input);
      }
      if (isMoment(input)) {
        return new Moment(checkOverflow(input));
      } else if (isDate(input)) {
        config._d = input;
      } else if (isArray(format2)) {
        configFromStringAndArray(config);
      } else if (format2) {
        configFromStringAndFormat(config);
      } else {
        configFromInput(config);
      }
      if (!isValid(config)) {
        config._d = null;
      }
      return config;
    }
    function configFromInput(config) {
      var input = config._i;
      if (isUndefined(input)) {
        config._d = new Date(hooks.now());
      } else if (isDate(input)) {
        config._d = new Date(input.valueOf());
      } else if (typeof input === "string") {
        configFromString(config);
      } else if (isArray(input)) {
        config._a = map(input.slice(0), function(obj) {
          return parseInt(obj, 10);
        });
        configFromArray(config);
      } else if (isObject(input)) {
        configFromObject(config);
      } else if (isNumber(input)) {
        config._d = new Date(input);
      } else {
        hooks.createFromInputFallback(config);
      }
    }
    function createLocalOrUTC(input, format2, locale2, strict, isUTC) {
      var c = {};
      if (format2 === true || format2 === false) {
        strict = format2;
        format2 = undefined;
      }
      if (locale2 === true || locale2 === false) {
        strict = locale2;
        locale2 = undefined;
      }
      if (isObject(input) && isObjectEmpty(input) || isArray(input) && input.length === 0) {
        input = undefined;
      }
      c._isAMomentObject = true;
      c._useUTC = c._isUTC = isUTC;
      c._l = locale2;
      c._i = input;
      c._f = format2;
      c._strict = strict;
      return createFromConfig(c);
    }
    function createLocal(input, format2, locale2, strict) {
      return createLocalOrUTC(input, format2, locale2, strict, false);
    }
    var prototypeMin = deprecate("moment().min is deprecated, use moment.max instead. http://momentjs.com/guides/#/warnings/min-max/", function() {
      var other = createLocal.apply(null, arguments);
      if (this.isValid() && other.isValid()) {
        return other < this ? this : other;
      } else {
        return createInvalid();
      }
    }), prototypeMax = deprecate("moment().max is deprecated, use moment.min instead. http://momentjs.com/guides/#/warnings/min-max/", function() {
      var other = createLocal.apply(null, arguments);
      if (this.isValid() && other.isValid()) {
        return other > this ? this : other;
      } else {
        return createInvalid();
      }
    });
    function pickBy(fn, moments) {
      var res, i;
      if (moments.length === 1 && isArray(moments[0])) {
        moments = moments[0];
      }
      if (!moments.length) {
        return createLocal();
      }
      res = moments[0];
      for (i = 1;i < moments.length; ++i) {
        if (!moments[i].isValid() || moments[i][fn](res)) {
          res = moments[i];
        }
      }
      return res;
    }
    function min() {
      var args = [].slice.call(arguments, 0);
      return pickBy("isBefore", args);
    }
    function max() {
      var args = [].slice.call(arguments, 0);
      return pickBy("isAfter", args);
    }
    var now = function() {
      return Date.now ? Date.now() : +new Date;
    };
    var ordering = [
      "year",
      "quarter",
      "month",
      "week",
      "day",
      "hour",
      "minute",
      "second",
      "millisecond"
    ];
    function isDurationValid(m) {
      var key, unitHasDecimal = false, i, orderLen = ordering.length;
      for (key in m) {
        if (hasOwnProp(m, key) && !(indexOf.call(ordering, key) !== -1 && (m[key] == null || !isNaN(m[key])))) {
          return false;
        }
      }
      for (i = 0;i < orderLen; ++i) {
        if (m[ordering[i]]) {
          if (unitHasDecimal) {
            return false;
          }
          if (parseFloat(m[ordering[i]]) !== toInt(m[ordering[i]])) {
            unitHasDecimal = true;
          }
        }
      }
      return true;
    }
    function isValid$1() {
      return this._isValid;
    }
    function createInvalid$1() {
      return createDuration(NaN);
    }
    function Duration(duration) {
      var normalizedInput = normalizeObjectUnits(duration), years2 = normalizedInput.year || 0, quarters = normalizedInput.quarter || 0, months2 = normalizedInput.month || 0, weeks2 = normalizedInput.week || normalizedInput.isoWeek || 0, days2 = normalizedInput.day || 0, hours2 = normalizedInput.hour || 0, minutes2 = normalizedInput.minute || 0, seconds2 = normalizedInput.second || 0, milliseconds2 = normalizedInput.millisecond || 0;
      this._isValid = isDurationValid(normalizedInput);
      this._milliseconds = +milliseconds2 + seconds2 * 1000 + minutes2 * 60000 + hours2 * 1000 * 60 * 60;
      this._days = +days2 + weeks2 * 7;
      this._months = +months2 + quarters * 3 + years2 * 12;
      this._data = {};
      this._locale = getLocale();
      this._bubble();
    }
    function isDuration(obj) {
      return obj instanceof Duration;
    }
    function absRound(number) {
      if (number < 0) {
        return Math.round(-1 * number) * -1;
      } else {
        return Math.round(number);
      }
    }
    function compareArrays(array1, array2, dontConvert) {
      var len = Math.min(array1.length, array2.length), lengthDiff = Math.abs(array1.length - array2.length), diffs = 0, i;
      for (i = 0;i < len; i++) {
        if (dontConvert && array1[i] !== array2[i] || !dontConvert && toInt(array1[i]) !== toInt(array2[i])) {
          diffs++;
        }
      }
      return diffs + lengthDiff;
    }
    function offset(token2, separator) {
      addFormatToken(token2, 0, 0, function() {
        var offset2 = this.utcOffset(), sign2 = "+";
        if (offset2 < 0) {
          offset2 = -offset2;
          sign2 = "-";
        }
        return sign2 + zeroFill(~~(offset2 / 60), 2) + separator + zeroFill(~~offset2 % 60, 2);
      });
    }
    offset("Z", ":");
    offset("ZZ", "");
    addRegexToken("Z", matchShortOffset);
    addRegexToken("ZZ", matchShortOffset);
    addParseToken(["Z", "ZZ"], function(input, array, config) {
      config._useUTC = true;
      config._tzm = offsetFromString(matchShortOffset, input);
    });
    var chunkOffset = /([\+\-]|\d\d)/gi;
    function offsetFromString(matcher, string) {
      var matches = (string || "").match(matcher), chunk, parts, minutes2;
      if (matches === null) {
        return null;
      }
      chunk = matches[matches.length - 1] || [];
      parts = (chunk + "").match(chunkOffset) || ["-", 0, 0];
      minutes2 = +(parts[1] * 60) + toInt(parts[2]);
      return minutes2 === 0 ? 0 : parts[0] === "+" ? minutes2 : -minutes2;
    }
    function cloneWithOffset(input, model) {
      var res, diff2;
      if (model._isUTC) {
        res = model.clone();
        diff2 = (isMoment(input) || isDate(input) ? input.valueOf() : createLocal(input).valueOf()) - res.valueOf();
        res._d.setTime(res._d.valueOf() + diff2);
        hooks.updateOffset(res, false);
        return res;
      } else {
        return createLocal(input).local();
      }
    }
    function getDateOffset(m) {
      return -Math.round(m._d.getTimezoneOffset());
    }
    hooks.updateOffset = function() {};
    function getSetOffset(input, keepLocalTime, keepMinutes) {
      var offset2 = this._offset || 0, localAdjust;
      if (!this.isValid()) {
        return input != null ? this : NaN;
      }
      if (input != null) {
        if (typeof input === "string") {
          input = offsetFromString(matchShortOffset, input);
          if (input === null) {
            return this;
          }
        } else if (Math.abs(input) < 16 && !keepMinutes) {
          input = input * 60;
        }
        if (!this._isUTC && keepLocalTime) {
          localAdjust = getDateOffset(this);
        }
        this._offset = input;
        this._isUTC = true;
        if (localAdjust != null) {
          this.add(localAdjust, "m");
        }
        if (offset2 !== input) {
          if (!keepLocalTime || this._changeInProgress) {
            addSubtract(this, createDuration(input - offset2, "m"), 1, false);
          } else if (!this._changeInProgress) {
            this._changeInProgress = true;
            hooks.updateOffset(this, true);
            this._changeInProgress = null;
          }
        }
        return this;
      } else {
        return this._isUTC ? offset2 : getDateOffset(this);
      }
    }
    function getSetZone(input, keepLocalTime) {
      if (input != null) {
        if (typeof input !== "string") {
          input = -input;
        }
        this.utcOffset(input, keepLocalTime);
        return this;
      } else {
        return -this.utcOffset();
      }
    }
    function setOffsetToUTC(keepLocalTime) {
      return this.utcOffset(0, keepLocalTime);
    }
    function setOffsetToLocal(keepLocalTime) {
      if (this._isUTC) {
        this.utcOffset(0, keepLocalTime);
        this._isUTC = false;
        if (keepLocalTime) {
          this.subtract(getDateOffset(this), "m");
        }
      }
      return this;
    }
    function setOffsetToParsedOffset() {
      if (this._tzm != null) {
        this.utcOffset(this._tzm, false, true);
      } else if (typeof this._i === "string") {
        var tZone = offsetFromString(matchOffset, this._i);
        if (tZone != null) {
          this.utcOffset(tZone);
        } else {
          this.utcOffset(0, true);
        }
      }
      return this;
    }
    function hasAlignedHourOffset(input) {
      if (!this.isValid()) {
        return false;
      }
      input = input ? createLocal(input).utcOffset() : 0;
      return (this.utcOffset() - input) % 60 === 0;
    }
    function isDaylightSavingTime() {
      return this.utcOffset() > this.clone().month(0).utcOffset() || this.utcOffset() > this.clone().month(5).utcOffset();
    }
    function isDaylightSavingTimeShifted() {
      if (!isUndefined(this._isDSTShifted)) {
        return this._isDSTShifted;
      }
      var c = {}, other;
      copyConfig(c, this);
      c = prepareConfig(c);
      if (c._a) {
        other = c._isUTC ? createUTC(c._a) : createLocal(c._a);
        this._isDSTShifted = this.isValid() && compareArrays(c._a, other.toArray()) > 0;
      } else {
        this._isDSTShifted = false;
      }
      return this._isDSTShifted;
    }
    function isLocal() {
      return this.isValid() ? !this._isUTC : false;
    }
    function isUtcOffset() {
      return this.isValid() ? this._isUTC : false;
    }
    function isUtc() {
      return this.isValid() ? this._isUTC && this._offset === 0 : false;
    }
    var aspNetRegex = /^(-|\+)?(?:(\d*)[. ])?(\d+):(\d+)(?::(\d+)(\.\d*)?)?$/, isoRegex = /^(-|\+)?P(?:([-+]?[0-9,.]*)Y)?(?:([-+]?[0-9,.]*)M)?(?:([-+]?[0-9,.]*)W)?(?:([-+]?[0-9,.]*)D)?(?:T(?:([-+]?[0-9,.]*)H)?(?:([-+]?[0-9,.]*)M)?(?:([-+]?[0-9,.]*)S)?)?$/;
    function createDuration(input, key) {
      var duration = input, match = null, sign2, ret, diffRes;
      if (isDuration(input)) {
        duration = {
          ms: input._milliseconds,
          d: input._days,
          M: input._months
        };
      } else if (isNumber(input) || !isNaN(+input)) {
        duration = {};
        if (key) {
          duration[key] = +input;
        } else {
          duration.milliseconds = +input;
        }
      } else if (match = aspNetRegex.exec(input)) {
        sign2 = match[1] === "-" ? -1 : 1;
        duration = {
          y: 0,
          d: toInt(match[DATE]) * sign2,
          h: toInt(match[HOUR]) * sign2,
          m: toInt(match[MINUTE]) * sign2,
          s: toInt(match[SECOND]) * sign2,
          ms: toInt(absRound(match[MILLISECOND] * 1000)) * sign2
        };
      } else if (match = isoRegex.exec(input)) {
        sign2 = match[1] === "-" ? -1 : 1;
        duration = {
          y: parseIso(match[2], sign2),
          M: parseIso(match[3], sign2),
          w: parseIso(match[4], sign2),
          d: parseIso(match[5], sign2),
          h: parseIso(match[6], sign2),
          m: parseIso(match[7], sign2),
          s: parseIso(match[8], sign2)
        };
      } else if (duration == null) {
        duration = {};
      } else if (typeof duration === "object" && (("from" in duration) || ("to" in duration))) {
        diffRes = momentsDifference(createLocal(duration.from), createLocal(duration.to));
        duration = {};
        duration.ms = diffRes.milliseconds;
        duration.M = diffRes.months;
      }
      ret = new Duration(duration);
      if (isDuration(input) && hasOwnProp(input, "_locale")) {
        ret._locale = input._locale;
      }
      if (isDuration(input) && hasOwnProp(input, "_isValid")) {
        ret._isValid = input._isValid;
      }
      return ret;
    }
    createDuration.fn = Duration.prototype;
    createDuration.invalid = createInvalid$1;
    function parseIso(inp, sign2) {
      var res = inp && parseFloat(inp.replace(",", "."));
      return (isNaN(res) ? 0 : res) * sign2;
    }
    function positiveMomentsDifference(base, other) {
      var res = {};
      res.months = other.month() - base.month() + (other.year() - base.year()) * 12;
      if (base.clone().add(res.months, "M").isAfter(other)) {
        --res.months;
      }
      res.milliseconds = +other - +base.clone().add(res.months, "M");
      return res;
    }
    function momentsDifference(base, other) {
      var res;
      if (!(base.isValid() && other.isValid())) {
        return { milliseconds: 0, months: 0 };
      }
      other = cloneWithOffset(other, base);
      if (base.isBefore(other)) {
        res = positiveMomentsDifference(base, other);
      } else {
        res = positiveMomentsDifference(other, base);
        res.milliseconds = -res.milliseconds;
        res.months = -res.months;
      }
      return res;
    }
    function createAdder(direction, name) {
      return function(val, period) {
        var dur, tmp;
        if (period !== null && !isNaN(+period)) {
          deprecateSimple(name, "moment()." + name + "(period, number) is deprecated. Please use moment()." + name + "(number, period). " + "See http://momentjs.com/guides/#/warnings/add-inverted-param/ for more info.");
          tmp = val;
          val = period;
          period = tmp;
        }
        dur = createDuration(val, period);
        addSubtract(this, dur, direction);
        return this;
      };
    }
    function addSubtract(mom, duration, isAdding, updateOffset) {
      var milliseconds2 = duration._milliseconds, days2 = absRound(duration._days), months2 = absRound(duration._months);
      if (!mom.isValid()) {
        return;
      }
      updateOffset = updateOffset == null ? true : updateOffset;
      if (months2) {
        setMonth(mom, get(mom, "Month") + months2 * isAdding);
      }
      if (days2) {
        set$1(mom, "Date", get(mom, "Date") + days2 * isAdding);
      }
      if (milliseconds2) {
        mom._d.setTime(mom._d.valueOf() + milliseconds2 * isAdding);
      }
      if (updateOffset) {
        hooks.updateOffset(mom, days2 || months2);
      }
    }
    var add = createAdder(1, "add"), subtract = createAdder(-1, "subtract");
    function isString(input) {
      return typeof input === "string" || input instanceof String;
    }
    function isMomentInput(input) {
      return isMoment(input) || isDate(input) || isString(input) || isNumber(input) || isNumberOrStringArray(input) || isMomentInputObject(input) || input === null || input === undefined;
    }
    function isMomentInputObject(input) {
      var objectTest = isObject(input) && !isObjectEmpty(input), propertyTest = false, properties = [
        "years",
        "year",
        "y",
        "months",
        "month",
        "M",
        "days",
        "day",
        "d",
        "dates",
        "date",
        "D",
        "hours",
        "hour",
        "h",
        "minutes",
        "minute",
        "m",
        "seconds",
        "second",
        "s",
        "milliseconds",
        "millisecond",
        "ms"
      ], i, property, propertyLen = properties.length;
      for (i = 0;i < propertyLen; i += 1) {
        property = properties[i];
        propertyTest = propertyTest || hasOwnProp(input, property);
      }
      return objectTest && propertyTest;
    }
    function isNumberOrStringArray(input) {
      var arrayTest = isArray(input), dataTypeTest = false;
      if (arrayTest) {
        dataTypeTest = input.filter(function(item) {
          return !isNumber(item) && isString(input);
        }).length === 0;
      }
      return arrayTest && dataTypeTest;
    }
    function isCalendarSpec(input) {
      var objectTest = isObject(input) && !isObjectEmpty(input), propertyTest = false, properties = [
        "sameDay",
        "nextDay",
        "lastDay",
        "nextWeek",
        "lastWeek",
        "sameElse"
      ], i, property;
      for (i = 0;i < properties.length; i += 1) {
        property = properties[i];
        propertyTest = propertyTest || hasOwnProp(input, property);
      }
      return objectTest && propertyTest;
    }
    function getCalendarFormat(myMoment, now2) {
      var diff2 = myMoment.diff(now2, "days", true);
      return diff2 < -6 ? "sameElse" : diff2 < -1 ? "lastWeek" : diff2 < 0 ? "lastDay" : diff2 < 1 ? "sameDay" : diff2 < 2 ? "nextDay" : diff2 < 7 ? "nextWeek" : "sameElse";
    }
    function calendar$1(time, formats) {
      if (arguments.length === 1) {
        if (!arguments[0]) {
          time = undefined;
          formats = undefined;
        } else if (isMomentInput(arguments[0])) {
          time = arguments[0];
          formats = undefined;
        } else if (isCalendarSpec(arguments[0])) {
          formats = arguments[0];
          time = undefined;
        }
      }
      var now2 = time || createLocal(), sod = cloneWithOffset(now2, this).startOf("day"), format2 = hooks.calendarFormat(this, sod) || "sameElse", output = formats && (isFunction(formats[format2]) ? formats[format2].call(this, now2) : formats[format2]);
      return this.format(output || this.localeData().calendar(format2, this, createLocal(now2)));
    }
    function clone() {
      return new Moment(this);
    }
    function isAfter(input, units) {
      var localInput = isMoment(input) ? input : createLocal(input);
      if (!(this.isValid() && localInput.isValid())) {
        return false;
      }
      units = normalizeUnits(units) || "millisecond";
      if (units === "millisecond") {
        return this.valueOf() > localInput.valueOf();
      } else {
        return localInput.valueOf() < this.clone().startOf(units).valueOf();
      }
    }
    function isBefore(input, units) {
      var localInput = isMoment(input) ? input : createLocal(input);
      if (!(this.isValid() && localInput.isValid())) {
        return false;
      }
      units = normalizeUnits(units) || "millisecond";
      if (units === "millisecond") {
        return this.valueOf() < localInput.valueOf();
      } else {
        return this.clone().endOf(units).valueOf() < localInput.valueOf();
      }
    }
    function isBetween(from2, to2, units, inclusivity) {
      var localFrom = isMoment(from2) ? from2 : createLocal(from2), localTo = isMoment(to2) ? to2 : createLocal(to2);
      if (!(this.isValid() && localFrom.isValid() && localTo.isValid())) {
        return false;
      }
      inclusivity = inclusivity || "()";
      return (inclusivity[0] === "(" ? this.isAfter(localFrom, units) : !this.isBefore(localFrom, units)) && (inclusivity[1] === ")" ? this.isBefore(localTo, units) : !this.isAfter(localTo, units));
    }
    function isSame(input, units) {
      var localInput = isMoment(input) ? input : createLocal(input), inputMs;
      if (!(this.isValid() && localInput.isValid())) {
        return false;
      }
      units = normalizeUnits(units) || "millisecond";
      if (units === "millisecond") {
        return this.valueOf() === localInput.valueOf();
      } else {
        inputMs = localInput.valueOf();
        return this.clone().startOf(units).valueOf() <= inputMs && inputMs <= this.clone().endOf(units).valueOf();
      }
    }
    function isSameOrAfter(input, units) {
      return this.isSame(input, units) || this.isAfter(input, units);
    }
    function isSameOrBefore(input, units) {
      return this.isSame(input, units) || this.isBefore(input, units);
    }
    function diff(input, units, asFloat) {
      var that, zoneDelta, output;
      if (!this.isValid()) {
        return NaN;
      }
      that = cloneWithOffset(input, this);
      if (!that.isValid()) {
        return NaN;
      }
      zoneDelta = (that.utcOffset() - this.utcOffset()) * 60000;
      units = normalizeUnits(units);
      switch (units) {
        case "year":
          output = monthDiff(this, that) / 12;
          break;
        case "month":
          output = monthDiff(this, that);
          break;
        case "quarter":
          output = monthDiff(this, that) / 3;
          break;
        case "second":
          output = (this - that) / 1000;
          break;
        case "minute":
          output = (this - that) / 60000;
          break;
        case "hour":
          output = (this - that) / 3600000;
          break;
        case "day":
          output = (this - that - zoneDelta) / 86400000;
          break;
        case "week":
          output = (this - that - zoneDelta) / 604800000;
          break;
        default:
          output = this - that;
      }
      return asFloat ? output : absFloor(output);
    }
    function monthDiff(a, b) {
      if (a.date() < b.date()) {
        return -monthDiff(b, a);
      }
      var wholeMonthDiff = (b.year() - a.year()) * 12 + (b.month() - a.month()), anchor = a.clone().add(wholeMonthDiff, "months"), anchor2, adjust;
      if (b - anchor < 0) {
        anchor2 = a.clone().add(wholeMonthDiff - 1, "months");
        adjust = (b - anchor) / (anchor - anchor2);
      } else {
        anchor2 = a.clone().add(wholeMonthDiff + 1, "months");
        adjust = (b - anchor) / (anchor2 - anchor);
      }
      return -(wholeMonthDiff + adjust) || 0;
    }
    hooks.defaultFormat = "YYYY-MM-DDTHH:mm:ssZ";
    hooks.defaultFormatUtc = "YYYY-MM-DDTHH:mm:ss[Z]";
    function toString() {
      return this.clone().locale("en").format("ddd MMM DD YYYY HH:mm:ss [GMT]ZZ");
    }
    function toISOString(keepOffset) {
      if (!this.isValid()) {
        return null;
      }
      var utc = keepOffset !== true, m = utc ? this.clone().utc() : this;
      if (m.year() < 0 || m.year() > 9999) {
        return formatMoment(m, utc ? "YYYYYY-MM-DD[T]HH:mm:ss.SSS[Z]" : "YYYYYY-MM-DD[T]HH:mm:ss.SSSZ");
      }
      if (isFunction(Date.prototype.toISOString)) {
        if (utc) {
          return this.toDate().toISOString();
        } else {
          return new Date(this.valueOf() + this.utcOffset() * 60 * 1000).toISOString().replace("Z", formatMoment(m, "Z"));
        }
      }
      return formatMoment(m, utc ? "YYYY-MM-DD[T]HH:mm:ss.SSS[Z]" : "YYYY-MM-DD[T]HH:mm:ss.SSSZ");
    }
    function inspect() {
      if (!this.isValid()) {
        return "moment.invalid(/* " + this._i + " */)";
      }
      var func = "moment", zone = "", prefix, year, datetime, suffix;
      if (!this.isLocal()) {
        func = this.utcOffset() === 0 ? "moment.utc" : "moment.parseZone";
        zone = "Z";
      }
      prefix = "[" + func + '("]';
      year = 0 <= this.year() && this.year() <= 9999 ? "YYYY" : "YYYYYY";
      datetime = "-MM-DD[T]HH:mm:ss.SSS";
      suffix = zone + '[")]';
      return this.format(prefix + year + datetime + suffix);
    }
    function format(inputString) {
      if (!inputString) {
        inputString = this.isUtc() ? hooks.defaultFormatUtc : hooks.defaultFormat;
      }
      var output = formatMoment(this, inputString);
      return this.localeData().postformat(output);
    }
    function from(time, withoutSuffix) {
      if (this.isValid() && (isMoment(time) && time.isValid() || createLocal(time).isValid())) {
        return createDuration({ to: this, from: time }).locale(this.locale()).humanize(!withoutSuffix);
      } else {
        return this.localeData().invalidDate();
      }
    }
    function fromNow(withoutSuffix) {
      return this.from(createLocal(), withoutSuffix);
    }
    function to(time, withoutSuffix) {
      if (this.isValid() && (isMoment(time) && time.isValid() || createLocal(time).isValid())) {
        return createDuration({ from: this, to: time }).locale(this.locale()).humanize(!withoutSuffix);
      } else {
        return this.localeData().invalidDate();
      }
    }
    function toNow(withoutSuffix) {
      return this.to(createLocal(), withoutSuffix);
    }
    function locale(key) {
      var newLocaleData;
      if (key === undefined) {
        return this._locale._abbr;
      } else {
        newLocaleData = getLocale(key);
        if (newLocaleData != null) {
          this._locale = newLocaleData;
        }
        return this;
      }
    }
    var lang = deprecate("moment().lang() is deprecated. Instead, use moment().localeData() to get the language configuration. Use moment().locale() to change languages.", function(key) {
      if (key === undefined) {
        return this.localeData();
      } else {
        return this.locale(key);
      }
    });
    function localeData() {
      return this._locale;
    }
    var MS_PER_SECOND = 1000, MS_PER_MINUTE = 60 * MS_PER_SECOND, MS_PER_HOUR = 60 * MS_PER_MINUTE, MS_PER_400_YEARS = (365 * 400 + 97) * 24 * MS_PER_HOUR;
    function mod$1(dividend, divisor) {
      return (dividend % divisor + divisor) % divisor;
    }
    function localStartOfDate(y, m, d) {
      if (y < 100 && y >= 0) {
        return new Date(y + 400, m, d) - MS_PER_400_YEARS;
      } else {
        return new Date(y, m, d).valueOf();
      }
    }
    function utcStartOfDate(y, m, d) {
      if (y < 100 && y >= 0) {
        return Date.UTC(y + 400, m, d) - MS_PER_400_YEARS;
      } else {
        return Date.UTC(y, m, d);
      }
    }
    function startOf(units) {
      var time, startOfDate;
      units = normalizeUnits(units);
      if (units === undefined || units === "millisecond" || !this.isValid()) {
        return this;
      }
      startOfDate = this._isUTC ? utcStartOfDate : localStartOfDate;
      switch (units) {
        case "year":
          time = startOfDate(this.year(), 0, 1);
          break;
        case "quarter":
          time = startOfDate(this.year(), this.month() - this.month() % 3, 1);
          break;
        case "month":
          time = startOfDate(this.year(), this.month(), 1);
          break;
        case "week":
          time = startOfDate(this.year(), this.month(), this.date() - this.weekday());
          break;
        case "isoWeek":
          time = startOfDate(this.year(), this.month(), this.date() - (this.isoWeekday() - 1));
          break;
        case "day":
        case "date":
          time = startOfDate(this.year(), this.month(), this.date());
          break;
        case "hour":
          time = this._d.valueOf();
          time -= mod$1(time + (this._isUTC ? 0 : this.utcOffset() * MS_PER_MINUTE), MS_PER_HOUR);
          break;
        case "minute":
          time = this._d.valueOf();
          time -= mod$1(time, MS_PER_MINUTE);
          break;
        case "second":
          time = this._d.valueOf();
          time -= mod$1(time, MS_PER_SECOND);
          break;
      }
      this._d.setTime(time);
      hooks.updateOffset(this, true);
      return this;
    }
    function endOf(units) {
      var time, startOfDate;
      units = normalizeUnits(units);
      if (units === undefined || units === "millisecond" || !this.isValid()) {
        return this;
      }
      startOfDate = this._isUTC ? utcStartOfDate : localStartOfDate;
      switch (units) {
        case "year":
          time = startOfDate(this.year() + 1, 0, 1) - 1;
          break;
        case "quarter":
          time = startOfDate(this.year(), this.month() - this.month() % 3 + 3, 1) - 1;
          break;
        case "month":
          time = startOfDate(this.year(), this.month() + 1, 1) - 1;
          break;
        case "week":
          time = startOfDate(this.year(), this.month(), this.date() - this.weekday() + 7) - 1;
          break;
        case "isoWeek":
          time = startOfDate(this.year(), this.month(), this.date() - (this.isoWeekday() - 1) + 7) - 1;
          break;
        case "day":
        case "date":
          time = startOfDate(this.year(), this.month(), this.date() + 1) - 1;
          break;
        case "hour":
          time = this._d.valueOf();
          time += MS_PER_HOUR - mod$1(time + (this._isUTC ? 0 : this.utcOffset() * MS_PER_MINUTE), MS_PER_HOUR) - 1;
          break;
        case "minute":
          time = this._d.valueOf();
          time += MS_PER_MINUTE - mod$1(time, MS_PER_MINUTE) - 1;
          break;
        case "second":
          time = this._d.valueOf();
          time += MS_PER_SECOND - mod$1(time, MS_PER_SECOND) - 1;
          break;
      }
      this._d.setTime(time);
      hooks.updateOffset(this, true);
      return this;
    }
    function valueOf() {
      return this._d.valueOf() - (this._offset || 0) * 60000;
    }
    function unix() {
      return Math.floor(this.valueOf() / 1000);
    }
    function toDate() {
      return new Date(this.valueOf());
    }
    function toArray() {
      var m = this;
      return [
        m.year(),
        m.month(),
        m.date(),
        m.hour(),
        m.minute(),
        m.second(),
        m.millisecond()
      ];
    }
    function toObject() {
      var m = this;
      return {
        years: m.year(),
        months: m.month(),
        date: m.date(),
        hours: m.hours(),
        minutes: m.minutes(),
        seconds: m.seconds(),
        milliseconds: m.milliseconds()
      };
    }
    function toJSON() {
      return this.isValid() ? this.toISOString() : null;
    }
    function isValid$2() {
      return isValid(this);
    }
    function parsingFlags() {
      return extend({}, getParsingFlags(this));
    }
    function invalidAt() {
      return getParsingFlags(this).overflow;
    }
    function creationData() {
      return {
        input: this._i,
        format: this._f,
        locale: this._locale,
        isUTC: this._isUTC,
        strict: this._strict
      };
    }
    addFormatToken("N", 0, 0, "eraAbbr");
    addFormatToken("NN", 0, 0, "eraAbbr");
    addFormatToken("NNN", 0, 0, "eraAbbr");
    addFormatToken("NNNN", 0, 0, "eraName");
    addFormatToken("NNNNN", 0, 0, "eraNarrow");
    addFormatToken("y", ["y", 1], "yo", "eraYear");
    addFormatToken("y", ["yy", 2], 0, "eraYear");
    addFormatToken("y", ["yyy", 3], 0, "eraYear");
    addFormatToken("y", ["yyyy", 4], 0, "eraYear");
    addRegexToken("N", matchEraAbbr);
    addRegexToken("NN", matchEraAbbr);
    addRegexToken("NNN", matchEraAbbr);
    addRegexToken("NNNN", matchEraName);
    addRegexToken("NNNNN", matchEraNarrow);
    addParseToken(["N", "NN", "NNN", "NNNN", "NNNNN"], function(input, array, config, token2) {
      var era = config._locale.erasParse(input, token2, config._strict);
      if (era) {
        getParsingFlags(config).era = era;
      } else {
        getParsingFlags(config).invalidEra = input;
      }
    });
    addRegexToken("y", matchUnsigned);
    addRegexToken("yy", matchUnsigned);
    addRegexToken("yyy", matchUnsigned);
    addRegexToken("yyyy", matchUnsigned);
    addRegexToken("yo", matchEraYearOrdinal);
    addParseToken(["y", "yy", "yyy", "yyyy"], YEAR);
    addParseToken(["yo"], function(input, array, config, token2) {
      var match;
      if (config._locale._eraYearOrdinalRegex) {
        match = input.match(config._locale._eraYearOrdinalRegex);
      }
      if (config._locale.eraYearOrdinalParse) {
        array[YEAR] = config._locale.eraYearOrdinalParse(input, match);
      } else {
        array[YEAR] = parseInt(input, 10);
      }
    });
    function localeEras(m, format2) {
      var i, l, date, eras = this._eras || getLocale("en")._eras;
      for (i = 0, l = eras.length;i < l; ++i) {
        switch (typeof eras[i].since) {
          case "string":
            date = hooks(eras[i].since).startOf("day");
            eras[i].since = date.valueOf();
            break;
        }
        switch (typeof eras[i].until) {
          case "undefined":
            eras[i].until = Infinity;
            break;
          case "string":
            date = hooks(eras[i].until).startOf("day").valueOf();
            eras[i].until = date.valueOf();
            break;
        }
      }
      return eras;
    }
    function localeErasParse(eraName, format2, strict) {
      var i, l, eras = this.eras(), name, abbr, narrow;
      eraName = eraName.toUpperCase();
      for (i = 0, l = eras.length;i < l; ++i) {
        name = eras[i].name.toUpperCase();
        abbr = eras[i].abbr.toUpperCase();
        narrow = eras[i].narrow.toUpperCase();
        if (strict) {
          switch (format2) {
            case "N":
            case "NN":
            case "NNN":
              if (abbr === eraName) {
                return eras[i];
              }
              break;
            case "NNNN":
              if (name === eraName) {
                return eras[i];
              }
              break;
            case "NNNNN":
              if (narrow === eraName) {
                return eras[i];
              }
              break;
          }
        } else if ([name, abbr, narrow].indexOf(eraName) >= 0) {
          return eras[i];
        }
      }
    }
    function localeErasConvertYear(era, year) {
      var dir = era.since <= era.until ? 1 : -1;
      if (year === undefined) {
        return hooks(era.since).year();
      } else {
        return hooks(era.since).year() + (year - era.offset) * dir;
      }
    }
    function getEraName() {
      var i, l, val, eras = this.localeData().eras();
      for (i = 0, l = eras.length;i < l; ++i) {
        val = this.clone().startOf("day").valueOf();
        if (eras[i].since <= val && val <= eras[i].until) {
          return eras[i].name;
        }
        if (eras[i].until <= val && val <= eras[i].since) {
          return eras[i].name;
        }
      }
      return "";
    }
    function getEraNarrow() {
      var i, l, val, eras = this.localeData().eras();
      for (i = 0, l = eras.length;i < l; ++i) {
        val = this.clone().startOf("day").valueOf();
        if (eras[i].since <= val && val <= eras[i].until) {
          return eras[i].narrow;
        }
        if (eras[i].until <= val && val <= eras[i].since) {
          return eras[i].narrow;
        }
      }
      return "";
    }
    function getEraAbbr() {
      var i, l, val, eras = this.localeData().eras();
      for (i = 0, l = eras.length;i < l; ++i) {
        val = this.clone().startOf("day").valueOf();
        if (eras[i].since <= val && val <= eras[i].until) {
          return eras[i].abbr;
        }
        if (eras[i].until <= val && val <= eras[i].since) {
          return eras[i].abbr;
        }
      }
      return "";
    }
    function getEraYear() {
      var i, l, dir, val, eras = this.localeData().eras();
      for (i = 0, l = eras.length;i < l; ++i) {
        dir = eras[i].since <= eras[i].until ? 1 : -1;
        val = this.clone().startOf("day").valueOf();
        if (eras[i].since <= val && val <= eras[i].until || eras[i].until <= val && val <= eras[i].since) {
          return (this.year() - hooks(eras[i].since).year()) * dir + eras[i].offset;
        }
      }
      return this.year();
    }
    function erasNameRegex(isStrict) {
      if (!hasOwnProp(this, "_erasNameRegex")) {
        computeErasParse.call(this);
      }
      return isStrict ? this._erasNameRegex : this._erasRegex;
    }
    function erasAbbrRegex(isStrict) {
      if (!hasOwnProp(this, "_erasAbbrRegex")) {
        computeErasParse.call(this);
      }
      return isStrict ? this._erasAbbrRegex : this._erasRegex;
    }
    function erasNarrowRegex(isStrict) {
      if (!hasOwnProp(this, "_erasNarrowRegex")) {
        computeErasParse.call(this);
      }
      return isStrict ? this._erasNarrowRegex : this._erasRegex;
    }
    function matchEraAbbr(isStrict, locale2) {
      return locale2.erasAbbrRegex(isStrict);
    }
    function matchEraName(isStrict, locale2) {
      return locale2.erasNameRegex(isStrict);
    }
    function matchEraNarrow(isStrict, locale2) {
      return locale2.erasNarrowRegex(isStrict);
    }
    function matchEraYearOrdinal(isStrict, locale2) {
      return locale2._eraYearOrdinalRegex || matchUnsigned;
    }
    function computeErasParse() {
      var abbrPieces = [], namePieces = [], narrowPieces = [], mixedPieces = [], i, l, erasName, erasAbbr, erasNarrow, eras = this.eras();
      for (i = 0, l = eras.length;i < l; ++i) {
        erasName = regexEscape(eras[i].name);
        erasAbbr = regexEscape(eras[i].abbr);
        erasNarrow = regexEscape(eras[i].narrow);
        namePieces.push(erasName);
        abbrPieces.push(erasAbbr);
        narrowPieces.push(erasNarrow);
        mixedPieces.push(erasName);
        mixedPieces.push(erasAbbr);
        mixedPieces.push(erasNarrow);
      }
      this._erasRegex = new RegExp("^(" + mixedPieces.join("|") + ")", "i");
      this._erasNameRegex = new RegExp("^(" + namePieces.join("|") + ")", "i");
      this._erasAbbrRegex = new RegExp("^(" + abbrPieces.join("|") + ")", "i");
      this._erasNarrowRegex = new RegExp("^(" + narrowPieces.join("|") + ")", "i");
    }
    addFormatToken(0, ["gg", 2], 0, function() {
      return this.weekYear() % 100;
    });
    addFormatToken(0, ["GG", 2], 0, function() {
      return this.isoWeekYear() % 100;
    });
    function addWeekYearFormatToken(token2, getter) {
      addFormatToken(0, [token2, token2.length], 0, getter);
    }
    addWeekYearFormatToken("gggg", "weekYear");
    addWeekYearFormatToken("ggggg", "weekYear");
    addWeekYearFormatToken("GGGG", "isoWeekYear");
    addWeekYearFormatToken("GGGGG", "isoWeekYear");
    addRegexToken("G", matchSigned);
    addRegexToken("g", matchSigned);
    addRegexToken("GG", match1to2, match2);
    addRegexToken("gg", match1to2, match2);
    addRegexToken("GGGG", match1to4, match4);
    addRegexToken("gggg", match1to4, match4);
    addRegexToken("GGGGG", match1to6, match6);
    addRegexToken("ggggg", match1to6, match6);
    addWeekParseToken(["gggg", "ggggg", "GGGG", "GGGGG"], function(input, week, config, token2) {
      week[token2.substr(0, 2)] = toInt(input);
    });
    addWeekParseToken(["gg", "GG"], function(input, week, config, token2) {
      week[token2] = hooks.parseTwoDigitYear(input);
    });
    function getSetWeekYear(input) {
      return getSetWeekYearHelper.call(this, input, this.week(), this.weekday() + this.localeData()._week.dow, this.localeData()._week.dow, this.localeData()._week.doy);
    }
    function getSetISOWeekYear(input) {
      return getSetWeekYearHelper.call(this, input, this.isoWeek(), this.isoWeekday(), 1, 4);
    }
    function getISOWeeksInYear() {
      return weeksInYear(this.year(), 1, 4);
    }
    function getISOWeeksInISOWeekYear() {
      return weeksInYear(this.isoWeekYear(), 1, 4);
    }
    function getWeeksInYear() {
      var weekInfo = this.localeData()._week;
      return weeksInYear(this.year(), weekInfo.dow, weekInfo.doy);
    }
    function getWeeksInWeekYear() {
      var weekInfo = this.localeData()._week;
      return weeksInYear(this.weekYear(), weekInfo.dow, weekInfo.doy);
    }
    function getSetWeekYearHelper(input, week, weekday, dow, doy) {
      var weeksTarget;
      if (input == null) {
        return weekOfYear(this, dow, doy).year;
      } else {
        weeksTarget = weeksInYear(input, dow, doy);
        if (week > weeksTarget) {
          week = weeksTarget;
        }
        return setWeekAll.call(this, input, week, weekday, dow, doy);
      }
    }
    function setWeekAll(weekYear, week, weekday, dow, doy) {
      var dayOfYearData = dayOfYearFromWeeks(weekYear, week, weekday, dow, doy), date = createUTCDate(dayOfYearData.year, 0, dayOfYearData.dayOfYear);
      this.year(date.getUTCFullYear());
      this.month(date.getUTCMonth());
      this.date(date.getUTCDate());
      return this;
    }
    addFormatToken("Q", 0, "Qo", "quarter");
    addRegexToken("Q", match1);
    addParseToken("Q", function(input, array) {
      array[MONTH] = (toInt(input) - 1) * 3;
    });
    function getSetQuarter(input) {
      return input == null ? Math.ceil((this.month() + 1) / 3) : this.month((input - 1) * 3 + this.month() % 3);
    }
    addFormatToken("D", ["DD", 2], "Do", "date");
    addRegexToken("D", match1to2, match1to2NoLeadingZero);
    addRegexToken("DD", match1to2, match2);
    addRegexToken("Do", function(isStrict, locale2) {
      return isStrict ? locale2._dayOfMonthOrdinalParse || locale2._ordinalParse : locale2._dayOfMonthOrdinalParseLenient;
    });
    addParseToken(["D", "DD"], DATE);
    addParseToken("Do", function(input, array) {
      array[DATE] = toInt(input.match(match1to2)[0]);
    });
    var getSetDayOfMonth = makeGetSet("Date", true);
    addFormatToken("DDD", ["DDDD", 3], "DDDo", "dayOfYear");
    addRegexToken("DDD", match1to3);
    addRegexToken("DDDD", match3);
    addParseToken(["DDD", "DDDD"], function(input, array, config) {
      config._dayOfYear = toInt(input);
    });
    function getSetDayOfYear(input) {
      var dayOfYear = Math.round((this.clone().startOf("day") - this.clone().startOf("year")) / 86400000) + 1;
      return input == null ? dayOfYear : this.add(input - dayOfYear, "d");
    }
    addFormatToken("m", ["mm", 2], 0, "minute");
    addRegexToken("m", match1to2, match1to2HasZero);
    addRegexToken("mm", match1to2, match2);
    addParseToken(["m", "mm"], MINUTE);
    var getSetMinute = makeGetSet("Minutes", false);
    addFormatToken("s", ["ss", 2], 0, "second");
    addRegexToken("s", match1to2, match1to2HasZero);
    addRegexToken("ss", match1to2, match2);
    addParseToken(["s", "ss"], SECOND);
    var getSetSecond = makeGetSet("Seconds", false);
    addFormatToken("S", 0, 0, function() {
      return ~~(this.millisecond() / 100);
    });
    addFormatToken(0, ["SS", 2], 0, function() {
      return ~~(this.millisecond() / 10);
    });
    addFormatToken(0, ["SSS", 3], 0, "millisecond");
    addFormatToken(0, ["SSSS", 4], 0, function() {
      return this.millisecond() * 10;
    });
    addFormatToken(0, ["SSSSS", 5], 0, function() {
      return this.millisecond() * 100;
    });
    addFormatToken(0, ["SSSSSS", 6], 0, function() {
      return this.millisecond() * 1000;
    });
    addFormatToken(0, ["SSSSSSS", 7], 0, function() {
      return this.millisecond() * 1e4;
    });
    addFormatToken(0, ["SSSSSSSS", 8], 0, function() {
      return this.millisecond() * 1e5;
    });
    addFormatToken(0, ["SSSSSSSSS", 9], 0, function() {
      return this.millisecond() * 1e6;
    });
    addRegexToken("S", match1to3, match1);
    addRegexToken("SS", match1to3, match2);
    addRegexToken("SSS", match1to3, match3);
    var token, getSetMillisecond;
    for (token = "SSSS";token.length <= 9; token += "S") {
      addRegexToken(token, matchUnsigned);
    }
    function parseMs(input, array) {
      array[MILLISECOND] = toInt(("0." + input) * 1000);
    }
    for (token = "S";token.length <= 9; token += "S") {
      addParseToken(token, parseMs);
    }
    getSetMillisecond = makeGetSet("Milliseconds", false);
    addFormatToken("z", 0, 0, "zoneAbbr");
    addFormatToken("zz", 0, 0, "zoneName");
    function getZoneAbbr() {
      return this._isUTC ? "UTC" : "";
    }
    function getZoneName() {
      return this._isUTC ? "Coordinated Universal Time" : "";
    }
    var proto = Moment.prototype;
    proto.add = add;
    proto.calendar = calendar$1;
    proto.clone = clone;
    proto.diff = diff;
    proto.endOf = endOf;
    proto.format = format;
    proto.from = from;
    proto.fromNow = fromNow;
    proto.to = to;
    proto.toNow = toNow;
    proto.get = stringGet;
    proto.invalidAt = invalidAt;
    proto.isAfter = isAfter;
    proto.isBefore = isBefore;
    proto.isBetween = isBetween;
    proto.isSame = isSame;
    proto.isSameOrAfter = isSameOrAfter;
    proto.isSameOrBefore = isSameOrBefore;
    proto.isValid = isValid$2;
    proto.lang = lang;
    proto.locale = locale;
    proto.localeData = localeData;
    proto.max = prototypeMax;
    proto.min = prototypeMin;
    proto.parsingFlags = parsingFlags;
    proto.set = stringSet;
    proto.startOf = startOf;
    proto.subtract = subtract;
    proto.toArray = toArray;
    proto.toObject = toObject;
    proto.toDate = toDate;
    proto.toISOString = toISOString;
    proto.inspect = inspect;
    if (typeof Symbol !== "undefined" && Symbol.for != null) {
      proto[Symbol.for("nodejs.util.inspect.custom")] = function() {
        return "Moment<" + this.format() + ">";
      };
    }
    proto.toJSON = toJSON;
    proto.toString = toString;
    proto.unix = unix;
    proto.valueOf = valueOf;
    proto.creationData = creationData;
    proto.eraName = getEraName;
    proto.eraNarrow = getEraNarrow;
    proto.eraAbbr = getEraAbbr;
    proto.eraYear = getEraYear;
    proto.year = getSetYear;
    proto.isLeapYear = getIsLeapYear;
    proto.weekYear = getSetWeekYear;
    proto.isoWeekYear = getSetISOWeekYear;
    proto.quarter = proto.quarters = getSetQuarter;
    proto.month = getSetMonth;
    proto.daysInMonth = getDaysInMonth;
    proto.week = proto.weeks = getSetWeek;
    proto.isoWeek = proto.isoWeeks = getSetISOWeek;
    proto.weeksInYear = getWeeksInYear;
    proto.weeksInWeekYear = getWeeksInWeekYear;
    proto.isoWeeksInYear = getISOWeeksInYear;
    proto.isoWeeksInISOWeekYear = getISOWeeksInISOWeekYear;
    proto.date = getSetDayOfMonth;
    proto.day = proto.days = getSetDayOfWeek;
    proto.weekday = getSetLocaleDayOfWeek;
    proto.isoWeekday = getSetISODayOfWeek;
    proto.dayOfYear = getSetDayOfYear;
    proto.hour = proto.hours = getSetHour;
    proto.minute = proto.minutes = getSetMinute;
    proto.second = proto.seconds = getSetSecond;
    proto.millisecond = proto.milliseconds = getSetMillisecond;
    proto.utcOffset = getSetOffset;
    proto.utc = setOffsetToUTC;
    proto.local = setOffsetToLocal;
    proto.parseZone = setOffsetToParsedOffset;
    proto.hasAlignedHourOffset = hasAlignedHourOffset;
    proto.isDST = isDaylightSavingTime;
    proto.isLocal = isLocal;
    proto.isUtcOffset = isUtcOffset;
    proto.isUtc = isUtc;
    proto.isUTC = isUtc;
    proto.zoneAbbr = getZoneAbbr;
    proto.zoneName = getZoneName;
    proto.dates = deprecate("dates accessor is deprecated. Use date instead.", getSetDayOfMonth);
    proto.months = deprecate("months accessor is deprecated. Use month instead", getSetMonth);
    proto.years = deprecate("years accessor is deprecated. Use year instead", getSetYear);
    proto.zone = deprecate("moment().zone is deprecated, use moment().utcOffset instead. http://momentjs.com/guides/#/warnings/zone/", getSetZone);
    proto.isDSTShifted = deprecate("isDSTShifted is deprecated. See http://momentjs.com/guides/#/warnings/dst-shifted/ for more information", isDaylightSavingTimeShifted);
    function createUnix(input) {
      return createLocal(input * 1000);
    }
    function createInZone() {
      return createLocal.apply(null, arguments).parseZone();
    }
    function preParsePostFormat(string) {
      return string;
    }
    var proto$1 = Locale.prototype;
    proto$1.calendar = calendar;
    proto$1.longDateFormat = longDateFormat;
    proto$1.invalidDate = invalidDate;
    proto$1.ordinal = ordinal;
    proto$1.preparse = preParsePostFormat;
    proto$1.postformat = preParsePostFormat;
    proto$1.relativeTime = relativeTime;
    proto$1.pastFuture = pastFuture;
    proto$1.set = set;
    proto$1.eras = localeEras;
    proto$1.erasParse = localeErasParse;
    proto$1.erasConvertYear = localeErasConvertYear;
    proto$1.erasAbbrRegex = erasAbbrRegex;
    proto$1.erasNameRegex = erasNameRegex;
    proto$1.erasNarrowRegex = erasNarrowRegex;
    proto$1.months = localeMonths;
    proto$1.monthsShort = localeMonthsShort;
    proto$1.monthsParse = localeMonthsParse;
    proto$1.monthsRegex = monthsRegex;
    proto$1.monthsShortRegex = monthsShortRegex;
    proto$1.week = localeWeek;
    proto$1.firstDayOfYear = localeFirstDayOfYear;
    proto$1.firstDayOfWeek = localeFirstDayOfWeek;
    proto$1.weekdays = localeWeekdays;
    proto$1.weekdaysMin = localeWeekdaysMin;
    proto$1.weekdaysShort = localeWeekdaysShort;
    proto$1.weekdaysParse = localeWeekdaysParse;
    proto$1.weekdaysRegex = weekdaysRegex;
    proto$1.weekdaysShortRegex = weekdaysShortRegex;
    proto$1.weekdaysMinRegex = weekdaysMinRegex;
    proto$1.isPM = localeIsPM;
    proto$1.meridiem = localeMeridiem;
    function get$1(format2, index, field, setter) {
      var locale2 = getLocale(), utc = createUTC().set(setter, index);
      return locale2[field](utc, format2);
    }
    function listMonthsImpl(format2, index, field) {
      if (isNumber(format2)) {
        index = format2;
        format2 = undefined;
      }
      format2 = format2 || "";
      if (index != null) {
        return get$1(format2, index, field, "month");
      }
      var i, out = [];
      for (i = 0;i < 12; i++) {
        out[i] = get$1(format2, i, field, "month");
      }
      return out;
    }
    function listWeekdaysImpl(localeSorted, format2, index, field) {
      if (typeof localeSorted === "boolean") {
        if (isNumber(format2)) {
          index = format2;
          format2 = undefined;
        }
        format2 = format2 || "";
      } else {
        format2 = localeSorted;
        index = format2;
        localeSorted = false;
        if (isNumber(format2)) {
          index = format2;
          format2 = undefined;
        }
        format2 = format2 || "";
      }
      var locale2 = getLocale(), shift = localeSorted ? locale2._week.dow : 0, i, out = [];
      if (index != null) {
        return get$1(format2, (index + shift) % 7, field, "day");
      }
      for (i = 0;i < 7; i++) {
        out[i] = get$1(format2, (i + shift) % 7, field, "day");
      }
      return out;
    }
    function listMonths(format2, index) {
      return listMonthsImpl(format2, index, "months");
    }
    function listMonthsShort(format2, index) {
      return listMonthsImpl(format2, index, "monthsShort");
    }
    function listWeekdays(localeSorted, format2, index) {
      return listWeekdaysImpl(localeSorted, format2, index, "weekdays");
    }
    function listWeekdaysShort(localeSorted, format2, index) {
      return listWeekdaysImpl(localeSorted, format2, index, "weekdaysShort");
    }
    function listWeekdaysMin(localeSorted, format2, index) {
      return listWeekdaysImpl(localeSorted, format2, index, "weekdaysMin");
    }
    getSetGlobalLocale("en", {
      eras: [
        {
          since: "0001-01-01",
          until: Infinity,
          offset: 1,
          name: "Anno Domini",
          narrow: "AD",
          abbr: "AD"
        },
        {
          since: "0000-12-31",
          until: -Infinity,
          offset: 1,
          name: "Before Christ",
          narrow: "BC",
          abbr: "BC"
        }
      ],
      dayOfMonthOrdinalParse: /\d{1,2}(th|st|nd|rd)/,
      ordinal: function(number) {
        var b = number % 10, output = toInt(number % 100 / 10) === 1 ? "th" : b === 1 ? "st" : b === 2 ? "nd" : b === 3 ? "rd" : "th";
        return number + output;
      }
    });
    hooks.lang = deprecate("moment.lang is deprecated. Use moment.locale instead.", getSetGlobalLocale);
    hooks.langData = deprecate("moment.langData is deprecated. Use moment.localeData instead.", getLocale);
    var mathAbs = Math.abs;
    function abs() {
      var data = this._data;
      this._milliseconds = mathAbs(this._milliseconds);
      this._days = mathAbs(this._days);
      this._months = mathAbs(this._months);
      data.milliseconds = mathAbs(data.milliseconds);
      data.seconds = mathAbs(data.seconds);
      data.minutes = mathAbs(data.minutes);
      data.hours = mathAbs(data.hours);
      data.months = mathAbs(data.months);
      data.years = mathAbs(data.years);
      return this;
    }
    function addSubtract$1(duration, input, value, direction) {
      var other = createDuration(input, value);
      duration._milliseconds += direction * other._milliseconds;
      duration._days += direction * other._days;
      duration._months += direction * other._months;
      return duration._bubble();
    }
    function add$1(input, value) {
      return addSubtract$1(this, input, value, 1);
    }
    function subtract$1(input, value) {
      return addSubtract$1(this, input, value, -1);
    }
    function absCeil(number) {
      if (number < 0) {
        return Math.floor(number);
      } else {
        return Math.ceil(number);
      }
    }
    function bubble() {
      var milliseconds2 = this._milliseconds, days2 = this._days, months2 = this._months, data = this._data, seconds2, minutes2, hours2, years2, monthsFromDays;
      if (!(milliseconds2 >= 0 && days2 >= 0 && months2 >= 0 || milliseconds2 <= 0 && days2 <= 0 && months2 <= 0)) {
        milliseconds2 += absCeil(monthsToDays(months2) + days2) * 86400000;
        days2 = 0;
        months2 = 0;
      }
      data.milliseconds = milliseconds2 % 1000;
      seconds2 = absFloor(milliseconds2 / 1000);
      data.seconds = seconds2 % 60;
      minutes2 = absFloor(seconds2 / 60);
      data.minutes = minutes2 % 60;
      hours2 = absFloor(minutes2 / 60);
      data.hours = hours2 % 24;
      days2 += absFloor(hours2 / 24);
      monthsFromDays = absFloor(daysToMonths(days2));
      months2 += monthsFromDays;
      days2 -= absCeil(monthsToDays(monthsFromDays));
      years2 = absFloor(months2 / 12);
      months2 %= 12;
      data.days = days2;
      data.months = months2;
      data.years = years2;
      return this;
    }
    function daysToMonths(days2) {
      return days2 * 4800 / 146097;
    }
    function monthsToDays(months2) {
      return months2 * 146097 / 4800;
    }
    function as(units) {
      if (!this.isValid()) {
        return NaN;
      }
      var days2, months2, milliseconds2 = this._milliseconds;
      units = normalizeUnits(units);
      if (units === "month" || units === "quarter" || units === "year") {
        days2 = this._days + milliseconds2 / 86400000;
        months2 = this._months + daysToMonths(days2);
        switch (units) {
          case "month":
            return months2;
          case "quarter":
            return months2 / 3;
          case "year":
            return months2 / 12;
        }
      } else {
        days2 = this._days + Math.round(monthsToDays(this._months));
        switch (units) {
          case "week":
            return days2 / 7 + milliseconds2 / 604800000;
          case "day":
            return days2 + milliseconds2 / 86400000;
          case "hour":
            return days2 * 24 + milliseconds2 / 3600000;
          case "minute":
            return days2 * 1440 + milliseconds2 / 60000;
          case "second":
            return days2 * 86400 + milliseconds2 / 1000;
          case "millisecond":
            return Math.floor(days2 * 86400000) + milliseconds2;
          default:
            throw new Error("Unknown unit " + units);
        }
      }
    }
    function makeAs(alias) {
      return function() {
        return this.as(alias);
      };
    }
    var asMilliseconds = makeAs("ms"), asSeconds = makeAs("s"), asMinutes = makeAs("m"), asHours = makeAs("h"), asDays = makeAs("d"), asWeeks = makeAs("w"), asMonths = makeAs("M"), asQuarters = makeAs("Q"), asYears = makeAs("y"), valueOf$1 = asMilliseconds;
    function clone$1() {
      return createDuration(this);
    }
    function get$2(units) {
      units = normalizeUnits(units);
      return this.isValid() ? this[units + "s"]() : NaN;
    }
    function makeGetter(name) {
      return function() {
        return this.isValid() ? this._data[name] : NaN;
      };
    }
    var milliseconds = makeGetter("milliseconds"), seconds = makeGetter("seconds"), minutes = makeGetter("minutes"), hours = makeGetter("hours"), days = makeGetter("days"), months = makeGetter("months"), years = makeGetter("years");
    function weeks() {
      return absFloor(this.days() / 7);
    }
    var round = Math.round, thresholds = {
      ss: 44,
      s: 45,
      m: 45,
      h: 22,
      d: 26,
      w: null,
      M: 11
    };
    function substituteTimeAgo(string, number, withoutSuffix, isFuture, locale2) {
      return locale2.relativeTime(number || 1, !!withoutSuffix, string, isFuture);
    }
    function relativeTime$1(posNegDuration, withoutSuffix, thresholds2, locale2) {
      var duration = createDuration(posNegDuration).abs(), seconds2 = round(duration.as("s")), minutes2 = round(duration.as("m")), hours2 = round(duration.as("h")), days2 = round(duration.as("d")), months2 = round(duration.as("M")), weeks2 = round(duration.as("w")), years2 = round(duration.as("y")), a = seconds2 <= thresholds2.ss && ["s", seconds2] || seconds2 < thresholds2.s && ["ss", seconds2] || minutes2 <= 1 && ["m"] || minutes2 < thresholds2.m && ["mm", minutes2] || hours2 <= 1 && ["h"] || hours2 < thresholds2.h && ["hh", hours2] || days2 <= 1 && ["d"] || days2 < thresholds2.d && ["dd", days2];
      if (thresholds2.w != null) {
        a = a || weeks2 <= 1 && ["w"] || weeks2 < thresholds2.w && ["ww", weeks2];
      }
      a = a || months2 <= 1 && ["M"] || months2 < thresholds2.M && ["MM", months2] || years2 <= 1 && ["y"] || ["yy", years2];
      a[2] = withoutSuffix;
      a[3] = +posNegDuration > 0;
      a[4] = locale2;
      return substituteTimeAgo.apply(null, a);
    }
    function getSetRelativeTimeRounding(roundingFunction) {
      if (roundingFunction === undefined) {
        return round;
      }
      if (typeof roundingFunction === "function") {
        round = roundingFunction;
        return true;
      }
      return false;
    }
    function getSetRelativeTimeThreshold(threshold, limit) {
      if (thresholds[threshold] === undefined) {
        return false;
      }
      if (limit === undefined) {
        return thresholds[threshold];
      }
      thresholds[threshold] = limit;
      if (threshold === "s") {
        thresholds.ss = limit - 1;
      }
      return true;
    }
    function humanize(argWithSuffix, argThresholds) {
      if (!this.isValid()) {
        return this.localeData().invalidDate();
      }
      var withSuffix = false, th = thresholds, locale2, output;
      if (typeof argWithSuffix === "object") {
        argThresholds = argWithSuffix;
        argWithSuffix = false;
      }
      if (typeof argWithSuffix === "boolean") {
        withSuffix = argWithSuffix;
      }
      if (typeof argThresholds === "object") {
        th = Object.assign({}, thresholds, argThresholds);
        if (argThresholds.s != null && argThresholds.ss == null) {
          th.ss = argThresholds.s - 1;
        }
      }
      locale2 = this.localeData();
      output = relativeTime$1(this, !withSuffix, th, locale2);
      if (withSuffix) {
        output = locale2.pastFuture(+this, output);
      }
      return locale2.postformat(output);
    }
    var abs$1 = Math.abs;
    function sign(x) {
      return (x > 0) - (x < 0) || +x;
    }
    function toISOString$1() {
      if (!this.isValid()) {
        return this.localeData().invalidDate();
      }
      var seconds2 = abs$1(this._milliseconds) / 1000, days2 = abs$1(this._days), months2 = abs$1(this._months), minutes2, hours2, years2, s, total = this.asSeconds(), totalSign, ymSign, daysSign, hmsSign;
      if (!total) {
        return "P0D";
      }
      minutes2 = absFloor(seconds2 / 60);
      hours2 = absFloor(minutes2 / 60);
      seconds2 %= 60;
      minutes2 %= 60;
      years2 = absFloor(months2 / 12);
      months2 %= 12;
      s = seconds2 ? seconds2.toFixed(3).replace(/\.?0+$/, "") : "";
      totalSign = total < 0 ? "-" : "";
      ymSign = sign(this._months) !== sign(total) ? "-" : "";
      daysSign = sign(this._days) !== sign(total) ? "-" : "";
      hmsSign = sign(this._milliseconds) !== sign(total) ? "-" : "";
      return totalSign + "P" + (years2 ? ymSign + years2 + "Y" : "") + (months2 ? ymSign + months2 + "M" : "") + (days2 ? daysSign + days2 + "D" : "") + (hours2 || minutes2 || seconds2 ? "T" : "") + (hours2 ? hmsSign + hours2 + "H" : "") + (minutes2 ? hmsSign + minutes2 + "M" : "") + (seconds2 ? hmsSign + s + "S" : "");
    }
    var proto$2 = Duration.prototype;
    proto$2.isValid = isValid$1;
    proto$2.abs = abs;
    proto$2.add = add$1;
    proto$2.subtract = subtract$1;
    proto$2.as = as;
    proto$2.asMilliseconds = asMilliseconds;
    proto$2.asSeconds = asSeconds;
    proto$2.asMinutes = asMinutes;
    proto$2.asHours = asHours;
    proto$2.asDays = asDays;
    proto$2.asWeeks = asWeeks;
    proto$2.asMonths = asMonths;
    proto$2.asQuarters = asQuarters;
    proto$2.asYears = asYears;
    proto$2.valueOf = valueOf$1;
    proto$2._bubble = bubble;
    proto$2.clone = clone$1;
    proto$2.get = get$2;
    proto$2.milliseconds = milliseconds;
    proto$2.seconds = seconds;
    proto$2.minutes = minutes;
    proto$2.hours = hours;
    proto$2.days = days;
    proto$2.weeks = weeks;
    proto$2.months = months;
    proto$2.years = years;
    proto$2.humanize = humanize;
    proto$2.toISOString = toISOString$1;
    proto$2.toString = toISOString$1;
    proto$2.toJSON = toISOString$1;
    proto$2.locale = locale;
    proto$2.localeData = localeData;
    proto$2.toIsoString = deprecate("toIsoString() is deprecated. Please use toISOString() instead (notice the capitals)", toISOString$1);
    proto$2.lang = lang;
    addFormatToken("X", 0, 0, "unix");
    addFormatToken("x", 0, 0, "valueOf");
    addRegexToken("x", matchSigned);
    addRegexToken("X", matchTimestamp);
    addParseToken("X", function(input, array, config) {
      config._d = new Date(parseFloat(input) * 1000);
    });
    addParseToken("x", function(input, array, config) {
      config._d = new Date(toInt(input));
    });
    //! moment.js
    hooks.version = "2.30.1";
    setHookCallback(createLocal);
    hooks.fn = proto;
    hooks.min = min;
    hooks.max = max;
    hooks.now = now;
    hooks.utc = createUTC;
    hooks.unix = createUnix;
    hooks.months = listMonths;
    hooks.isDate = isDate;
    hooks.locale = getSetGlobalLocale;
    hooks.invalid = createInvalid;
    hooks.duration = createDuration;
    hooks.isMoment = isMoment;
    hooks.weekdays = listWeekdays;
    hooks.parseZone = createInZone;
    hooks.localeData = getLocale;
    hooks.isDuration = isDuration;
    hooks.monthsShort = listMonthsShort;
    hooks.weekdaysMin = listWeekdaysMin;
    hooks.defineLocale = defineLocale;
    hooks.updateLocale = updateLocale;
    hooks.locales = listLocales;
    hooks.weekdaysShort = listWeekdaysShort;
    hooks.normalizeUnits = normalizeUnits;
    hooks.relativeTimeRounding = getSetRelativeTimeRounding;
    hooks.relativeTimeThreshold = getSetRelativeTimeThreshold;
    hooks.calendarFormat = getCalendarFormat;
    hooks.prototype = proto;
    hooks.HTML5_FMT = {
      DATETIME_LOCAL: "YYYY-MM-DDTHH:mm",
      DATETIME_LOCAL_SECONDS: "YYYY-MM-DDTHH:mm:ss",
      DATETIME_LOCAL_MS: "YYYY-MM-DDTHH:mm:ss.SSS",
      DATE: "YYYY-MM-DD",
      TIME: "HH:mm",
      TIME_SECONDS: "HH:mm:ss",
      TIME_MS: "HH:mm:ss.SSS",
      WEEK: "GGGG-[W]WW",
      MONTH: "YYYY-MM"
    };
    return hooks;
  });
});

// ../../node_modules/file-stream-rotator/FileStreamRotator.js
var require_FileStreamRotator = __commonJS((exports, module) => {
  /*!
   * FileStreamRotator
   * Copyright(c) 2012-2017 Holiday Extras.
   * Copyright(c) 2017 Roger C.
   * MIT Licensed
   */
  var fs = __require("fs");
  var path = __require("path");
  var moment = require_moment();
  var crypto2 = __require("crypto");
  var EventEmitter = __require("events");
  var FileStreamRotator = {};
  module.exports = FileStreamRotator;
  var staticFrequency = ["daily", "test", "m", "h", "custom"];
  var DATE_FORMAT = "YYYYMMDDHHmm";
  var _checkNumAndType = function(type, num) {
    if (typeof num == "number") {
      switch (type) {
        case "m":
          if (num < 0 || num > 60) {
            return false;
          }
          break;
        case "h":
          if (num < 0 || num > 24) {
            return false;
          }
          break;
      }
      return { type, digit: num };
    }
  };
  var _checkDailyAndTest = function(freqType) {
    switch (freqType) {
      case "custom":
      case "daily":
        return { type: freqType, digit: undefined };
        break;
      case "test":
        return { type: freqType, digit: 0 };
    }
    return false;
  };
  FileStreamRotator.getFrequency = function(frequency) {
    var _f = frequency.toLowerCase().match(/^(\d+)([mh])$/);
    if (_f) {
      return _checkNumAndType(_f[2], parseInt(_f[1]));
    }
    var dailyOrTest = _checkDailyAndTest(frequency);
    if (dailyOrTest) {
      return dailyOrTest;
    }
    return false;
  };
  FileStreamRotator.parseFileSize = function(size) {
    if (size && typeof size == "string") {
      var _s = size.toLowerCase().match(/^((?:0\.)?\d+)([kmg])$/);
      if (_s) {
        switch (_s[2]) {
          case "k":
            return _s[1] * 1024;
          case "m":
            return _s[1] * 1024 * 1024;
          case "g":
            return _s[1] * 1024 * 1024 * 1024;
        }
      }
    }
    return null;
  };
  FileStreamRotator.getDate = function(format, date_format, utc) {
    date_format = date_format || DATE_FORMAT;
    let currentMoment = utc ? moment.utc() : moment().local();
    if (format && staticFrequency.indexOf(format.type) !== -1) {
      switch (format.type) {
        case "m":
          var minute = Math.floor(currentMoment.minutes() / format.digit) * format.digit;
          return currentMoment.minutes(minute).format(date_format);
          break;
        case "h":
          var hour = Math.floor(currentMoment.hour() / format.digit) * format.digit;
          return currentMoment.hour(hour).format(date_format);
          break;
        case "daily":
        case "custom":
        case "test":
          return currentMoment.format(date_format);
      }
    }
    return currentMoment.format(date_format);
  };
  FileStreamRotator.setAuditLog = function(max_logs, audit_file, log_file) {
    var _rtn = null;
    if (max_logs) {
      var use_days = max_logs.toString().substr(-1);
      var _num = max_logs.toString().match(/^(\d+)/);
      if (Number(_num[1]) > 0) {
        var baseLog = path.dirname(log_file.replace(/%DATE%.+/, "_filename"));
        try {
          if (audit_file) {
            var full_path = path.resolve(audit_file);
            _rtn = JSON.parse(fs.readFileSync(full_path, { encoding: "utf-8" }));
          } else {
            var full_path = path.resolve(baseLog + "/" + ".audit.json");
            _rtn = JSON.parse(fs.readFileSync(full_path, { encoding: "utf-8" }));
          }
        } catch (e) {
          if (e.code !== "ENOENT") {
            return null;
          }
          _rtn = {
            keep: {
              days: false,
              amount: Number(_num[1])
            },
            auditLog: audit_file || baseLog + "/" + ".audit.json",
            files: []
          };
        }
        _rtn.keep = {
          days: use_days === "d",
          amount: Number(_num[1])
        };
      }
    }
    return _rtn;
  };
  FileStreamRotator.writeAuditLog = function(audit, verbose) {
    try {
      mkDirForFile(audit.auditLog);
      fs.writeFileSync(audit.auditLog, JSON.stringify(audit, null, 4));
    } catch (e) {
      if (verbose) {
        console.error(new Date, "[FileStreamRotator] Failed to store log audit at:", audit.auditLog, "Error:", e);
      }
    }
  };
  function removeFile(file, verbose) {
    if (file.hash === crypto2.createHash(file.hashType).update(file.name + "LOG_FILE" + file.date).digest("hex")) {
      try {
        if (fs.existsSync(file.name)) {
          fs.unlinkSync(file.name);
        }
      } catch (e) {
        if (verbose) {
          console.error(new Date, "[FileStreamRotator] Could not remove old log file: ", file.name);
        }
      }
    }
  }
  function createCurrentSymLink(logfile, name, verbose) {
    let symLinkName = name || "current.log";
    let logPath = path.dirname(logfile);
    let logfileName = path.basename(logfile);
    let current = logPath + "/" + symLinkName;
    try {
      let stats = fs.lstatSync(current);
      if (stats.isSymbolicLink()) {
        fs.unlinkSync(current);
        fs.symlinkSync(logfileName, current);
      }
    } catch (err) {
      if (err && err.code == "ENOENT") {
        try {
          fs.symlinkSync(logfileName, current);
        } catch (e) {
          if (verbose) {
            console.error(new Date, "[FileStreamRotator] Could not create symlink file: ", current, " -> ", logfileName);
          }
        }
      }
    }
  }
  function createLogWatcher(logfile, verbose, cb) {
    if (!logfile)
      return null;
    try {
      let stats = fs.lstatSync(logfile);
      return fs.watch(logfile, function(event, filename) {
        if (event == "rename") {
          try {
            let stats2 = fs.lstatSync(logfile);
          } catch (err) {
            cb(err, logfile);
          }
        }
      });
    } catch (err) {
      if (verbose) {
        console.log(new Date, "[FileStreamRotator] Could not add watcher for " + logfile);
      }
    }
  }
  FileStreamRotator.addLogToAudit = function(logfile, audit, stream, verbose) {
    if (audit && audit.files) {
      var index = audit.files.findIndex(function(file) {
        return file.name === logfile;
      });
      if (index !== -1) {
        return audit;
      }
      var time = Date.now();
      audit.files.push({
        date: time,
        name: logfile,
        hash: crypto2.createHash(audit.hashType).update(logfile + "LOG_FILE" + time).digest("hex")
      });
      if (audit.keep.days) {
        var oldestDate = moment().subtract(audit.keep.amount, "days").valueOf();
        var recentFiles = audit.files.filter(function(file) {
          if (file.date > oldestDate) {
            return true;
          }
          file.hashType = audit.hashType;
          removeFile(file, verbose);
          stream.emit("logRemoved", file);
          return false;
        });
        audit.files = recentFiles;
      } else {
        var filesToKeep = audit.files.splice(-audit.keep.amount);
        if (audit.files.length > 0) {
          audit.files.filter(function(file) {
            file.hashType = audit.hashType;
            removeFile(file, verbose);
            stream.emit("logRemoved", file);
            return false;
          });
        }
        audit.files = filesToKeep;
      }
      FileStreamRotator.writeAuditLog(audit, verbose);
    }
    return audit;
  };
  FileStreamRotator.getStream = function(options) {
    var frequencyMetaData = null;
    var curDate = null;
    var self2 = this;
    if (!options.filename) {
      console.error(new Date, "[FileStreamRotator] No filename supplied. Defaulting to STDOUT");
      return process.stdout;
    }
    if (options.frequency) {
      frequencyMetaData = self2.getFrequency(options.frequency);
    }
    let auditLog = self2.setAuditLog(options.max_logs, options.audit_file, options.filename);
    if (auditLog != null) {
      auditLog.hashType = options.audit_hash_type !== undefined ? options.audit_hash_type : "md5";
    }
    self2.verbose = options.verbose !== undefined ? options.verbose : true;
    var fileSize = null;
    var fileCount = 0;
    var curSize = 0;
    if (options.size) {
      fileSize = FileStreamRotator.parseFileSize(options.size);
    }
    var dateFormat = options.date_format || DATE_FORMAT;
    if (frequencyMetaData && frequencyMetaData.type == "daily") {
      if (!options.date_format) {
        dateFormat = "YYYY-MM-DD";
      }
      if (moment().format(dateFormat) != moment().endOf("day").format(dateFormat) || moment().format(dateFormat) == moment().add(1, "day").format(dateFormat)) {
        if (self2.verbose) {
          console.log(new Date, "[FileStreamRotator] Changing type to custom as date format changes more often than once a day or not every day");
        }
        frequencyMetaData.type = "custom";
      }
    }
    if (frequencyMetaData) {
      curDate = options.frequency ? self2.getDate(frequencyMetaData, dateFormat, options.utc) : "";
    }
    options.create_symlink = options.create_symlink || false;
    options.extension = options.extension || "";
    var filename = options.filename;
    var oldFile = null;
    var logfile = filename + (curDate ? "." + curDate : "");
    if (filename.match(/%DATE%/)) {
      logfile = filename.replace(/%DATE%/g, curDate ? curDate : self2.getDate(null, dateFormat, options.utc));
    }
    if (fileSize) {
      var lastLogFile = null;
      var t_log = logfile;
      var f = null;
      if (auditLog && auditLog.files && auditLog.files instanceof Array && auditLog.files.length > 0) {
        var lastEntry = auditLog.files[auditLog.files.length - 1].name;
        if (lastEntry.match(t_log)) {
          var lastCount = lastEntry.match(t_log + "\\.(\\d+)");
          if (lastCount) {
            t_log = lastEntry;
            fileCount = lastCount[1];
          }
        }
      }
      if (fileCount == 0 && t_log == logfile) {
        t_log += options.extension;
      }
      while (f = fs.existsSync(t_log)) {
        lastLogFile = t_log;
        fileCount++;
        t_log = logfile + "." + fileCount + options.extension;
      }
      if (lastLogFile) {
        var lastLogFileStats = fs.statSync(lastLogFile);
        if (lastLogFileStats.size < fileSize) {
          t_log = lastLogFile;
          fileCount--;
          curSize = lastLogFileStats.size;
        }
      }
      logfile = t_log;
    } else {
      logfile += options.extension;
    }
    if (self2.verbose) {
      console.log(new Date, "[FileStreamRotator] Logging to: ", logfile);
    }
    mkDirForFile(logfile);
    var file_options = options.file_options || { flags: "a" };
    var rotateStream = fs.createWriteStream(logfile, file_options);
    if (curDate && frequencyMetaData && staticFrequency.indexOf(frequencyMetaData.type) > -1 || fileSize > 0) {
      if (self2.verbose) {
        console.log(new Date, "[FileStreamRotator] Rotating file: ", frequencyMetaData ? frequencyMetaData.type : "", fileSize ? "size: " + fileSize : "");
      }
      var stream = new EventEmitter;
      stream.auditLog = auditLog;
      stream.end = function() {
        rotateStream.end.apply(rotateStream, arguments);
      };
      BubbleEvents(rotateStream, stream);
      stream.on("close", function() {
        if (logWatcher) {
          logWatcher.close();
        }
      });
      stream.on("new", function(newLog) {
        stream.auditLog = self2.addLogToAudit(newLog, stream.auditLog, stream, self2.verbose);
        if (options.create_symlink) {
          createCurrentSymLink(newLog, options.symlink_name, self2.verbose);
        }
        if (options.watch_log) {
          stream.emit("addWatcher", newLog);
        }
      });
      var logWatcher;
      stream.on("addWatcher", function(newLog) {
        if (logWatcher) {
          logWatcher.close();
        }
        if (!options.watch_log) {
          return;
        }
        logWatcher = createLogWatcher(newLog, self2.verbose, function(err, newLog2) {
          stream.emit("createLog", newLog2);
        });
      });
      stream.on("createLog", function(file) {
        try {
          let stats = fs.lstatSync(file);
        } catch (err) {
          if (rotateStream && rotateStream.end == "function") {
            rotateStream.end();
          }
          rotateStream = fs.createWriteStream(file, file_options);
          stream.emit("new", file);
          BubbleEvents(rotateStream, stream);
        }
      });
      stream.write = function(str, encoding) {
        var newDate = frequencyMetaData ? this.getDate(frequencyMetaData, dateFormat, options.utc) : curDate;
        if (newDate != curDate || fileSize && curSize > fileSize) {
          var newLogfile = filename + (curDate && frequencyMetaData ? "." + newDate : "");
          if (filename.match(/%DATE%/) && curDate) {
            newLogfile = filename.replace(/%DATE%/g, newDate);
          }
          if (fileSize && curSize > fileSize) {
            fileCount++;
            newLogfile += "." + fileCount + options.extension;
          } else {
            fileCount = 0;
            newLogfile += options.extension;
          }
          curSize = 0;
          if (self2.verbose) {
            console.log(new Date, __require("util").format("[FileStreamRotator] Changing logs from %s to %s", logfile, newLogfile));
          }
          curDate = newDate;
          oldFile = logfile;
          logfile = newLogfile;
          if (options.end_stream === true) {
            rotateStream.end();
          } else {
            rotateStream.destroy();
          }
          mkDirForFile(logfile);
          rotateStream = fs.createWriteStream(newLogfile, file_options);
          stream.emit("new", newLogfile);
          stream.emit("rotate", oldFile, newLogfile);
          BubbleEvents(rotateStream, stream);
        }
        rotateStream.write(str, encoding);
        curSize += Buffer.byteLength(str, encoding);
      }.bind(this);
      process.nextTick(function() {
        stream.emit("new", logfile);
      });
      stream.emit("new", logfile);
      return stream;
    } else {
      if (self2.verbose) {
        console.log(new Date, "[FileStreamRotator] File won't be rotated: ", options.frequency, options.size);
      }
      process.nextTick(function() {
        rotateStream.emit("new", logfile);
      });
      return rotateStream;
    }
  };
  var mkDirForFile = function(pathWithFile) {
    var _path = path.dirname(pathWithFile);
    _path.split(path.sep).reduce(function(fullPath, folder) {
      fullPath += folder + path.sep;
      if (!fs.existsSync(fullPath)) {
        try {
          fs.mkdirSync(fullPath);
        } catch (e) {
          if (e.code !== "EEXIST") {
            throw e;
          }
        }
      }
      return fullPath;
    }, "");
  };
  var BubbleEvents = function BubbleEvents2(emitter, proxy) {
    emitter.on("close", function() {
      proxy.emit("close");
    });
    emitter.on("finish", function() {
      proxy.emit("finish");
    });
    emitter.on("error", function(err) {
      proxy.emit("error", err);
    });
    emitter.on("open", function(fd) {
      proxy.emit("open", fd);
    });
  };
});

// ../../node_modules/winston-daily-rotate-file/daily-rotate-file.js
var require_daily_rotate_file = __commonJS((exports, module) => {
  var fs = __require("fs");
  var os = __require("os");
  var path = __require("path");
  var util = __require("util");
  var zlib = __require("zlib");
  var hash = require_object_hash();
  var MESSAGE = require_triple_beam().MESSAGE;
  var PassThrough = __require("stream").PassThrough;
  var Transport = require_winston_transport();
  var loggerDefaults = {
    json: false,
    colorize: false,
    eol: os.EOL,
    logstash: null,
    prettyPrint: false,
    label: null,
    stringify: false,
    depth: null,
    showLevel: true,
    timestamp: () => {
      return new Date().toISOString();
    }
  };
  var DailyRotateFile = function(options) {
    options = options || {};
    Transport.call(this, options);
    function throwIf(target) {
      Array.prototype.slice.call(arguments, 1).forEach((name) => {
        if (options[name]) {
          throw new Error("Cannot set " + name + " and " + target + " together");
        }
      });
    }
    function getMaxSize(size) {
      if (size && typeof size === "string") {
        if (size.toLowerCase().match(/^((?:0\.)?\d+)([kmg])$/)) {
          return size;
        }
      } else if (size && Number.isInteger(size)) {
        const sizeK = Math.round(size / 1024);
        return sizeK === 0 ? "1k" : sizeK + "k";
      }
      return null;
    }
    function isValidFileName(filename) {
      return !/["<>|:*?\\/\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0a\x0b\x0c\x0d\x0e\x0f\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1a\x1b\x1c\x1d\x1e\x1f]/g.test(filename);
    }
    function isValidDirName(dirname) {
      return !/["<>|\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0a\x0b\x0c\x0d\x0e\x0f\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1a\x1b\x1c\x1d\x1e\x1f]/g.test(dirname);
    }
    this.options = Object.assign({}, loggerDefaults, options);
    if (options.stream) {
      throwIf("stream", "filename", "maxsize");
      this.logStream = new PassThrough;
      this.logStream.pipe(options.stream);
    } else {
      this.filename = options.filename ? path.basename(options.filename) : "winston.log";
      this.dirname = options.dirname || path.dirname(options.filename);
      if (!isValidFileName(this.filename) || !isValidDirName(this.dirname)) {
        throw new Error("Your path or filename contain an invalid character.");
      }
      this.logStream = require_FileStreamRotator().getStream({
        filename: path.join(this.dirname, this.filename),
        frequency: options.frequency ? options.frequency : "custom",
        date_format: options.datePattern ? options.datePattern : "YYYY-MM-DD",
        verbose: false,
        size: getMaxSize(options.maxSize),
        max_logs: options.maxFiles,
        end_stream: true,
        audit_file: options.auditFile ? options.auditFile : path.join(this.dirname, "." + hash(options) + "-audit.json"),
        file_options: options.options ? options.options : { flags: "a" },
        utc: options.utc ? options.utc : false,
        extension: options.extension ? options.extension : "",
        create_symlink: options.createSymlink ? options.createSymlink : false,
        symlink_name: options.symlinkName ? options.symlinkName : "current.log",
        watch_log: options.watchLog ? options.watchLog : false,
        audit_hash_type: options.auditHashType ? options.auditHashType : "sha256"
      });
      this.logStream.on("new", (newFile) => {
        this.emit("new", newFile);
      });
      this.logStream.on("rotate", (oldFile, newFile) => {
        this.emit("rotate", oldFile, newFile);
      });
      this.logStream.on("logRemoved", (params) => {
        if (options.zippedArchive) {
          const gzName = params.name + ".gz";
          try {
            fs.unlinkSync(gzName);
          } catch (err) {
            if (err.code !== "ENOENT") {
              err.message = `Error occurred while removing ${gzName}: ${err.message}`;
              this.emit("error", err);
              return;
            }
          }
          this.emit("logRemoved", gzName);
          return;
        }
        this.emit("logRemoved", params.name);
      });
      if (options.zippedArchive) {
        this.logStream.on("rotate", (oldFile) => {
          try {
            if (!fs.existsSync(oldFile)) {
              return;
            }
          } catch (err) {
            err.message = `Error occurred while checking existence of ${oldFile}: ${err.message}`;
            this.emit("error", err);
            return;
          }
          try {
            if (fs.existsSync(`${oldFile}.gz`)) {
              return;
            }
          } catch (err) {
            err.message = `Error occurred while checking existence of ${oldFile}.gz: ${err.message}`;
            this.emit("error", err);
            return;
          }
          const gzip = zlib.createGzip();
          const inp = fs.createReadStream(oldFile);
          inp.on("error", (err) => {
            err.message = `Error occurred while reading ${oldFile}: ${err.message}`;
            this.emit("error", err);
          });
          const out = fs.createWriteStream(oldFile + ".gz");
          out.on("error", (err) => {
            err.message = `Error occurred while writing ${oldFile}.gz: ${err.message}`;
            this.emit("error", err);
          });
          inp.pipe(gzip).pipe(out).on("finish", () => {
            try {
              fs.unlinkSync(oldFile);
            } catch (err) {
              if (err.code !== "ENOENT") {
                err.message = `Error occurred while removing ${oldFile}: ${err.message}`;
                this.emit("error", err);
                return;
              }
            }
            this.emit("archive", oldFile + ".gz");
          });
        });
      }
      if (options.watchLog) {
        this.logStream.on("addWatcher", (newFile) => {
          this.emit("addWatcher", newFile);
        });
      }
    }
  };
  module.exports = DailyRotateFile;
  util.inherits(DailyRotateFile, Transport);
  DailyRotateFile.prototype.name = "dailyRotateFile";
  var noop = function() {};
  DailyRotateFile.prototype.log = function(info, callback) {
    callback = callback || noop;
    this.logStream.write(info[MESSAGE] + this.options.eol);
    this.emit("logged", info);
    callback(null, true);
  };
  DailyRotateFile.prototype.close = function() {
    if (this.logStream) {
      this.logStream.end(() => {
        this.emit("finish");
      });
    }
  };
  DailyRotateFile.prototype.query = function(options, callback) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    if (!this.options.json) {
      throw new Error("query() may not be used without the json option being set to true");
    }
    if (!this.filename) {
      throw new Error("query() may not be used when initializing with a stream");
    }
    let results = [];
    options = options || {};
    options.rows = options.rows || options.limit || 10;
    options.start = options.start || 0;
    options.until = options.until || new Date;
    if (typeof options.until !== "object") {
      options.until = new Date(options.until);
    }
    options.from = options.from || options.until - 24 * 60 * 60 * 1000;
    if (typeof options.from !== "object") {
      options.from = new Date(options.from);
    }
    options.order = options.order || "desc";
    const logFiles = (() => {
      const fileRegex = new RegExp(this.filename.replace("%DATE%", ".*"), "i");
      return fs.readdirSync(this.dirname).filter((file) => path.basename(file).match(fileRegex));
    })();
    if (logFiles.length === 0 && callback) {
      callback(null, results);
    }
    const processLogFile = (file) => {
      if (!file) {
        return;
      }
      const logFile = path.join(this.dirname, file);
      let buff = "";
      let stream;
      if (file.endsWith(".gz")) {
        stream = new PassThrough;
        const inp = fs.createReadStream(logFile);
        inp.on("error", (err) => {
          err.message = `Error occurred while reading ${logFile}: ${err.message}`;
          stream.emit("error", err);
        });
        inp.pipe(zlib.createGunzip()).pipe(stream);
      } else {
        stream = fs.createReadStream(logFile, {
          encoding: "utf8"
        });
      }
      stream.on("error", (err) => {
        if (stream.readable) {
          stream.destroy();
        }
        if (!callback) {
          return;
        }
        return err.code === "ENOENT" ? callback(null, results) : callback(err);
      });
      stream.on("data", (data) => {
        data = (buff + data).split(/\n+/);
        const l = data.length - 1;
        for (let i = 0;i < l; i++) {
          add(data[i]);
        }
        buff = data[l];
      });
      stream.on("end", () => {
        if (buff) {
          add(buff, true);
        }
        if (logFiles.length) {
          processLogFile(logFiles.shift());
        } else if (callback) {
          results.sort((a, b) => {
            const d1 = new Date(a.timestamp).getTime();
            const d2 = new Date(b.timestamp).getTime();
            return d1 > d2 ? 1 : d1 < d2 ? -1 : 0;
          });
          if (options.order === "desc") {
            results = results.reverse();
          }
          const start = options.start || 0;
          const limit = options.limit || results.length;
          results = results.slice(start, start + limit);
          if (options.fields) {
            results = results.map((log) => {
              const obj = {};
              options.fields.forEach((key) => {
                obj[key] = log[key];
              });
              return obj;
            });
          }
          callback(null, results);
        }
      });
      function add(buff2, attempt) {
        try {
          const log = JSON.parse(buff2);
          if (!log || typeof log !== "object") {
            return;
          }
          const time = new Date(log.timestamp);
          if (options.from && time < options.from || options.until && time > options.until || options.level && options.level !== log.level) {
            return;
          }
          results.push(log);
        } catch (e) {
          if (!attempt) {
            stream.emit("error", e);
          }
        }
      }
    };
    processLogFile(logFiles.shift());
  };
});

// ../utils/package.json
var engines;
var init_package = __esm(() => {
  engines = {
    bun: ">=1.3.14"
  };
});

// ../utils/src/dirs.ts
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
function normalizeProfileName(profile) {
  const normalized = profile?.trim();
  if (!normalized || normalized === "default")
    return;
  if (normalized === "." || normalized === ".." || normalized.endsWith(".") || !PROFILE_NAME_RE.test(normalized) || WINDOWS_RESERVED_BASENAME_RE.test(normalized)) {
    throw new Error(`Invalid OMP profile "${profile}". Profile names must match ${PROFILE_NAME_RE.source}, ` + `cannot be "." or "..", cannot end with ".", and cannot be a Windows reserved device name ` + `(CON, PRN, AUX, NUL, COM0-9, LPT0-9, or any of those with an extension).`);
  }
  return normalized;
}
function resolveProfileEnv(omp, pi) {
  return normalizeProfileName(omp !== undefined ? omp : pi);
}
function getProfileFromEnv() {
  return resolveProfileEnv(process.env.OMP_PROFILE, process.env.PI_PROFILE);
}
function readProfileFromEnvSafe() {
  try {
    return getProfileFromEnv();
  } catch {
    return;
  }
}
function getBaseConfigRoot() {
  return path.join(os.homedir(), getConfigDirName());
}
function getProfileConfigRoot(profile) {
  const root = getBaseConfigRoot();
  return profile ? path.join(root, "profiles", profile) : root;
}
function readPiProfileFromEnvSafe() {
  try {
    return normalizeProfileName(process.env.PI_PROFILE);
  } catch {
    return;
  }
}
function getProfileAgentDir(profile) {
  return path.join(getProfileConfigRoot(profile), "agent");
}
function isProfileDerivedAgentDir(profile, agentDirEnv) {
  return profile !== undefined && agentDirEnv === getProfileAgentDir(profile);
}
function standardizeMacOSPath(p) {
  if (process.platform !== "darwin" || !p.startsWith("/private/"))
    return p;
  const stripped = p.slice("/private".length);
  try {
    if (fs.realpathSync(p) === fs.realpathSync(stripped)) {
      return stripped;
    }
  } catch {}
  return p;
}
function getConfigDirName() {
  return process.env.PI_CONFIG_DIR || CONFIG_DIR_NAME;
}

class DirResolver {
  configRoot;
  agentDir;
  #rootDirs;
  #agentDirs;
  #rootCache = new Map;
  #agentCache = new Map;
  constructor(options = {}) {
    const profile = normalizeProfileName(options.profile);
    this.configRoot = getProfileConfigRoot(profile);
    const defaultAgent = path.join(this.configRoot, "agent");
    const agentDirOverride = profile ? undefined : options.agentDirOverride;
    this.agentDir = agentDirOverride ? path.resolve(agentDirOverride) : defaultAgent;
    const isDefault = this.agentDir === defaultAgent;
    let xdgData;
    let xdgState;
    let xdgCache;
    if ((process.platform === "linux" || process.platform === "darwin") && isDefault) {
      const resolveIf = (envVar) => {
        const value = process.env[envVar];
        if (!value)
          return;
        try {
          const appRoot = path.join(value, APP_NAME);
          if (profile) {
            const profilePath = path.join(appRoot, "profiles", profile);
            if (fs.existsSync(profilePath)) {
              return profilePath;
            }
            return;
          }
          if (fs.existsSync(appRoot)) {
            return appRoot;
          }
        } catch {}
        return;
      };
      xdgData = resolveIf("XDG_DATA_HOME");
      xdgState = resolveIf("XDG_STATE_HOME");
      xdgCache = resolveIf("XDG_CACHE_HOME");
    }
    this.#rootDirs = {
      data: xdgData ?? this.configRoot,
      state: xdgState ?? this.configRoot,
      cache: xdgCache ?? this.configRoot
    };
    this.#agentDirs = {
      data: xdgData ?? this.agentDir,
      state: xdgState ?? this.agentDir,
      cache: xdgCache ?? this.agentDir
    };
  }
  rootSubdir(subdir, xdg) {
    const cached = this.#rootCache.get(subdir);
    if (cached)
      return cached;
    const base = xdg ? this.#rootDirs[xdg] : this.configRoot;
    const result = path.join(base, subdir);
    this.#rootCache.set(subdir, result);
    return result;
  }
  agentSubdir(userAgentDir, subdir, xdg) {
    if (!userAgentDir || userAgentDir === this.agentDir) {
      const cached = this.#agentCache.get(subdir);
      if (cached)
        return cached;
      const base = xdg ? this.#agentDirs[xdg] : this.agentDir;
      const result = path.join(base, subdir);
      this.#agentCache.set(subdir, result);
      return result;
    }
    return path.join(userAgentDir, subdir);
  }
}
function resolvePreProfileAgentDir(profile, agentDirEnv, profileAgentDirSource = profile) {
  return isProfileDerivedAgentDir(profile ?? profileAgentDirSource, agentDirEnv) ? undefined : agentDirEnv;
}
function resolveActiveAgentDirOverride() {
  return activeProfile ? undefined : resolvePreProfileAgentDir(undefined, process.env.PI_CODING_AGENT_DIR, readPiProfileFromEnvSafe());
}
function getLogsDir() {
  return dirs.rootSubdir("logs", "state");
}
var APP_NAME = "omp", CONFIG_DIR_NAME = ".omp", MIN_BUN_VERSION, PROFILE_NAME_RE, WINDOWS_RESERVED_BASENAME_RE, projectDir, activeProfile, dirs, preProfileAgentDirEnv, RESOLVER_HOME;
var init_dirs = __esm(() => {
  init_package();
  MIN_BUN_VERSION = engines.bun.replace(/[^0-9.]/g, "");
  PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
  WINDOWS_RESERVED_BASENAME_RE = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i;
  projectDir = standardizeMacOSPath(process.cwd());
  activeProfile = readProfileFromEnvSafe();
  dirs = new DirResolver({
    agentDirOverride: resolveActiveAgentDirOverride(),
    profile: activeProfile
  });
  preProfileAgentDirEnv = resolvePreProfileAgentDir(activeProfile, process.env.PI_CODING_AGENT_DIR, activeProfile ?? readPiProfileFromEnvSafe());
  RESOLVER_HOME = os.homedir();
});

// ../utils/src/timing-buffer.ts
var KEY;
var init_timing_buffer = __esm(() => {
  KEY = Symbol.for("omp.moduleLoadBuffer");
});

// ../utils/src/logger.ts
import { AsyncLocalStorage } from "async_hooks";
import * as fs2 from "fs";
import * as os2 from "os";
import * as path2 from "path";
function emitToSinks(level, message, context) {
  if (logSinks.size === 0)
    return;
  const event = { level, message, context, timestamp: new Date };
  for (const sink of logSinks) {
    try {
      sink(event);
    } catch {}
  }
}
function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && ("code" in error) && (error.code === "ESRCH" || error.code === "EINVAL"));
  }
}
function pruneStaleProcessLogs(dir) {
  let entries;
  try {
    entries = fs2.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const staleLogs = [];
  for (const entry of entries) {
    if (!entry.isFile())
      continue;
    const logMatch = PROCESS_LOG_PATTERN.exec(entry.name);
    const auditMatch = PROCESS_AUDIT_PATTERN.exec(entry.name);
    const pidText = logMatch?.[1] ?? auditMatch?.[1];
    if (!pidText || processIsRunning(Number(pidText)))
      continue;
    const entryPath = path2.join(dir, entry.name);
    if (auditMatch) {
      try {
        fs2.rmSync(entryPath, { force: true });
      } catch {}
      continue;
    }
    try {
      staleLogs.push({ path: entryPath, mtimeMs: fs2.statSync(entryPath).mtimeMs });
    } catch {}
  }
  staleLogs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const stale of staleLogs.slice(RETAINED_STALE_LOG_FILES)) {
    try {
      fs2.rmSync(stale.path, { force: true });
    } catch {}
  }
}
function ensureDir(dir) {
  if (!fs2.existsSync(dir)) {
    fs2.mkdirSync(dir, { recursive: true });
  }
  return dir;
}
function jsonReplacer(_key, value) {
  if (value instanceof Error) {
    const out = {
      name: value.name,
      message: value.message,
      stack: value.stack
    };
    const errAsRecord = value;
    for (const k in errAsRecord)
      out[k] = errAsRecord[k];
    if (value.cause !== undefined)
      out.cause = value.cause;
    return out;
  }
  return value;
}
function padTimestampPart(value, width = 2) {
  return String(value).padStart(width, "0");
}
function formatLocalTimestamp(date) {
  const offsetMinutes = -date.getTimezoneOffset();
  const absoluteOffset = Math.abs(offsetMinutes);
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  return `${padTimestampPart(date.getFullYear(), 4)}-${padTimestampPart(date.getMonth() + 1)}-${padTimestampPart(date.getDate())}` + `T${padTimestampPart(date.getHours())}:${padTimestampPart(date.getMinutes())}:${padTimestampPart(date.getSeconds())}` + `.${padTimestampPart(date.getMilliseconds(), 3)}${offsetSign}${padTimestampPart(Math.floor(absoluteOffset / 60))}` + `:${padTimestampPart(absoluteOffset % 60)}`;
}
function normalizeLogInfo(level, message, context) {
  const metadata = !FORMAT_TOKEN_PATTERN.test(message) && context !== null && typeof context === "object" ? context : undefined;
  const info = Object.assign({}, metadata, { level, message });
  if (metadata?.message)
    info.message = `${message} ${metadata.message}`;
  if (metadata?.stack)
    info.stack = metadata.stack;
  if (metadata?.cause)
    info.cause = metadata.cause;
  return info;
}
function formatLogInfo(info) {
  const timestamp = formatLocalTimestamp(new Date);
  info.timestamp = timestamp;
  const entry = {
    timestamp,
    level: info.level,
    pid: process.pid,
    message: info.message
  };
  for (const [key, value] of Object.entries(info)) {
    if (key !== "level" && key !== "timestamp" && key !== "message")
      entry[key] = value;
  }
  return JSON.stringify(entry, jsonReplacer);
}
function makeFileTransport(dir) {
  const logsDir = ensureDir(dir ?? getLogsDir());
  pruneStaleProcessLogs(logsDir);
  return new import_daily_rotate_file.default({
    dirname: logsDir,
    filename: `omp.%DATE%.${process.pid}.log`,
    datePattern: "YYYY-MM-DD",
    maxSize: "10m",
    maxFiles: 5,
    zippedArchive: false,
    auditFile: path2.join(logsDir, `.omp.${process.pid}-audit.json`)
  });
}
function buildTransports(opts) {
  return {
    file: opts.file ? makeFileTransport(typeof opts.file === "string" ? opts.file : undefined) : undefined,
    console: opts.console === true
  };
}
function getLocalTransports() {
  activeTransports ??= buildTransports(transportOpts);
  return activeTransports;
}
function emitLocally(level, message, context) {
  const transports = getLocalTransports();
  const info = normalizeLogInfo(level, message, context);
  if (!transports.file && !transports.console)
    return;
  const line = formatLogInfo(info);
  if (transports.file)
    transports.file.log({ [TRANSPORT_MESSAGE]: line }, onTransportLogged);
  if (transports.console)
    process.stdout.write(`${formatLogInfo(info)}${os2.EOL}`);
}
function error(message, context) {
  try {
    emitLocally("error", message, context);
  } catch {}
  emitToSinks("error", message, context);
}
function warn(message, context) {
  try {
    emitLocally("warn", message, context);
  } catch {}
  emitToSinks("warn", message, context);
}
function debug(message, context) {
  try {
    emitLocally("debug", message, context);
  } catch {}
  emitToSinks("debug", message, context);
}
var import_daily_rotate_file, logSinks, PROCESS_LOG_PATTERN, PROCESS_AUDIT_PATTERN, RETAINED_STALE_LOG_FILES = 5, FORMAT_TOKEN_PATTERN, transportOpts, activeTransports, TRANSPORT_MESSAGE, onTransportLogged = () => {}, spanStorage;
var init_logger = __esm(() => {
  init_dirs();
  init_timing_buffer();
  import_daily_rotate_file = __toESM(require_daily_rotate_file(), 1);
  logSinks = new Set;
  PROCESS_LOG_PATTERN = /^omp\.\d{4}-\d{2}-\d{2}\.(\d+)\.log(?:\.\d+)?$/;
  PROCESS_AUDIT_PATTERN = /^\.omp\.(\d+)-audit\.json$/;
  FORMAT_TOKEN_PATTERN = /%[scdjifoO%]/;
  transportOpts = { file: true };
  TRANSPORT_MESSAGE = Symbol.for("message");
  spanStorage = new AsyncLocalStorage;
});

// ../utils/src/stderr-guard.ts
import { dlopen, FFIType } from "bun:ffi";
import * as fs3 from "fs";
function libcFdOps() {
  if (libcFdOpsCache !== undefined)
    return libcFdOpsCache;
  libcFdOpsCache = null;
  if (process.platform === "win32")
    return null;
  const candidates = process.platform === "darwin" ? ["libSystem.B.dylib", "/usr/lib/libSystem.B.dylib"] : ["libc.so.6", "libc.so"];
  for (const candidate of candidates) {
    try {
      const libc = dlopen(candidate, {
        dup: { args: [FFIType.i32], returns: FFIType.i32 },
        dup2: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 }
      });
      libcFdOpsCache = libc.symbols;
      return libcFdOpsCache;
    } catch {}
  }
  return libcFdOpsCache;
}
function restoreTerminalStderr() {
  if (savedStderrFd === null)
    return;
  const saved = savedStderrFd;
  savedStderrFd = null;
  libcFdOps()?.dup2(saved, STDERR_FILENO);
  try {
    fs3.closeSync(saved);
  } catch {}
}
var STDERR_FILENO = 2, libcFdOpsCache, savedStderrFd = null;
var init_stderr_guard = __esm(() => {
  init_dirs();
});

// ../utils/src/postmortem.ts
import * as fs4 from "fs";
import inspector from "inspector";
import { isMainThread } from "worker_threads";
function runCleanup(reason) {
  switch (cleanupStage) {
    case "idle":
      cleanupStage = "running";
      break;
    case "running":
      return cleanupPromise ?? Promise.resolve();
    case "complete":
      return Promise.resolve();
  }
  const promises2 = callbackList.toReversed().map((callback) => {
    return Promise.try(() => callback(reason));
  });
  const cleanupSettled = Promise.allSettled(promises2).then((results) => {
    for (const result of results) {
      if (result.status === "rejected") {
        const err = result.reason instanceof Error ? result.reason : new Error(String(result.reason));
        error("Cleanup callback failed", { err, stack: err.stack });
      }
    }
    cleanupStage = "complete";
  });
  const deadline = Promise.withResolvers();
  const deadlineTimer = setTimeout(() => {
    error("Cleanup deadline exceeded; proceeding with exit", { reason });
    cleanupStage = "complete";
    deadline.resolve();
  }, CLEANUP_DEADLINE_MS);
  cleanupPromise = Promise.race([cleanupSettled, deadline.promise]).finally(() => {
    clearTimeout(deadlineTimer);
  });
  return cleanupPromise;
}
function classifyBrokenPipe(err) {
  if (!("code" in err) || err.code !== "EPIPE" || !("syscall" in err))
    return;
  if (err.syscall === "send")
    return "ipc-send";
  if (err.syscall === "write")
    return "stdio-write";
  return;
}
function markExpectedCleanupError(reason) {
  reason[EXPECTED_CLEANUP] = true;
  return reason;
}
function isExpectedCleanupError(reason) {
  let current = reason;
  for (let depth = 0;depth < 8 && current !== null && typeof current === "object"; depth++) {
    if (current[EXPECTED_CLEANUP] === true)
      return true;
    current = current.cause;
  }
  return false;
}
function formatFatalError(label, err) {
  const name = err.name || "Error";
  const message = err.message || "(no message)";
  const stack = err.stack || "";
  const stackLines = stack.split(`
`).slice(1);
  const formattedStack = stackLines.length > 0 ? `
${stackLines.join(`
`)}` : "";
  return `
[${label}] ${name}: ${message}${formattedStack}
`;
}
async function exitAfterFatal(label, logMessage, err, reason) {
  const forcedExit = setTimeout(() => exitProcess(1), CLEANUP_DEADLINE_MS);
  try {
    restoreTerminalStderr();
    try {
      fs4.writeSync(2, formatFatalError(label, err));
    } catch {}
    error(logMessage, { err });
    await runCleanup(reason);
  } finally {
    clearTimeout(forcedExit);
    exitProcess(1);
  }
}
async function runQuit(code, exitMode, options = {}) {
  await runCleanup("manual" /* MANUAL */);
  if (!isMainThread) {
    return;
  }
  if (options.drainStdout !== false && process.stdout.writableLength > 0) {
    const { promise, resolve: resolve2 } = Promise.withResolvers();
    process.stdout.once("drain", resolve2);
    await Promise.race([promise, Bun.sleep(5000)]);
  }
  switch (exitMode) {
    case "guarded":
      return process.exit(code);
    case "native":
      return exitProcess(code);
  }
}
var callbackList, cleanupStage = "idle", CLEANUP_DEADLINE_MS = 1e4, exitProcess, cleanupPromise, stdioDisconnectRegistrations = 0, inspectorOpened = false, EXPECTED_CLEANUP, rejectionInterceptors;
var init_postmortem = __esm(() => {
  init_logger();
  init_stderr_guard();
  callbackList = [];
  exitProcess = typeof process.reallyExit === "function" ? process.reallyExit.bind(process) : process.exit.bind(process);
  EXPECTED_CLEANUP = Symbol.for("omp.expectedCleanupError");
  rejectionInterceptors = new Set;
  if (isMainThread) {
    process.on("SIGINT", async () => {
      await runCleanup("sigint" /* SIGINT */);
      exitProcess(130);
    }).on("SIGUSR1", () => {
      if (inspectorOpened)
        return;
      inspectorOpened = true;
      inspector.open(undefined, undefined, false);
      const url = inspector.url();
      process.stderr.write(`Inspector opened: ${url}
`);
    }).on("uncaughtException", async (err) => {
      if (isExpectedCleanupError(err)) {
        warn("Ignoring expected cleanup exception", { err });
        return;
      }
      await exitAfterFatal("Uncaught Exception", "Uncaught exception", err, "uncaught_exception" /* UNCAUGHT_EXCEPTION */);
    }).on("unhandledRejection", async (reason) => {
      const err = reason instanceof Error ? reason : new Error(String(reason));
      const brokenPipeSource = classifyBrokenPipe(err);
      if (brokenPipeSource === "ipc-send") {
        warn("Ignoring EPIPE from worker IPC send; optional subsystem will self-recover", { err });
        return;
      }
      if (brokenPipeSource === "stdio-write" && stdioDisconnectRegistrations > 0) {
        warn("Stdio peer disconnected; shutting down gracefully", { err });
        await runQuit(0, "native");
        return;
      }
      if (isExpectedCleanupError(reason)) {
        warn("Ignoring expected cleanup rejection", { err });
        return;
      }
      for (const interceptor of rejectionInterceptors) {
        try {
          if (interceptor(reason))
            return;
        } catch (interceptorErr) {
          warn("Unhandled-rejection interceptor threw; continuing with fatal path", {
            err: interceptorErr
          });
        }
      }
      await exitAfterFatal("Unhandled Rejection", "Unhandled rejection", err, "unhandled_rejection" /* UNHANDLED_REJECTION */);
    }).on("exit", async () => {
      runCleanup("exit" /* EXIT */);
    }).on("SIGTERM", async () => {
      await runCleanup("sigterm" /* SIGTERM */);
      exitProcess(143);
    }).on("SIGHUP", async () => {
      await runCleanup("sighup" /* SIGHUP */);
      exitProcess(129);
    });
  } else {
    process.on("exit", () => {
      runCleanup("exit" /* EXIT */);
    });
  }
});

// ../utils/src/snowflake.ts
function randu32() {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}
var EPOCH = 1420070400000, MAX_SEQ = 4194303, Snowflake;
var init_snowflake = __esm(() => {
  ((Snowflake) => {
    Snowflake.PATTERN = /^[0-9a-f]{16}$/;
    Snowflake.EPOCH_TIMESTAMP = EPOCH;
    Snowflake.MAX_SEQUENCE = MAX_SEQ;
    function formatParts(dt, seq) {
      return (BigInt(dt) << 22n | BigInt(seq)).toString(16).padStart(16, "0");
    }
    Snowflake.formatParts = formatParts;

    class Source {
      #seq = 0;
      constructor(sequence = randu32() & MAX_SEQ) {
        this.#seq = sequence & MAX_SEQ;
      }
      get sequence() {
        return this.#seq & MAX_SEQ;
      }
      set sequence(v) {
        this.#seq = v & MAX_SEQ;
      }
      reset() {
        this.#seq = 0;
      }
      generate(timestamp) {
        const seq = this.#seq + 1 & MAX_SEQ;
        const dt = timestamp - EPOCH;
        this.#seq = seq;
        return formatParts(dt, seq);
      }
    }
    Snowflake.Source = Source;
    let defaultSource;
    function next(timestamp = Date.now()) {
      defaultSource ??= new Source;
      return defaultSource.generate(timestamp);
    }
    Snowflake.next = next;
    function valid(value) {
      return value.length === 16 && Snowflake.PATTERN.test(value);
    }
    Snowflake.valid = valid;
    function lowerbound(timelike) {
      switch (typeof timelike) {
        case "object":
          return formatParts(timelike.getTime() - EPOCH, 0);
        case "number":
          return formatParts(timelike - EPOCH, 0);
        case "string":
          return timelike;
      }
    }
    Snowflake.lowerbound = lowerbound;
    function upperbound(timelike) {
      switch (typeof timelike) {
        case "object":
          return formatParts(timelike.getTime() - EPOCH, MAX_SEQ);
        case "number":
          return formatParts(timelike - EPOCH, MAX_SEQ);
        case "string":
          return timelike;
      }
    }
    Snowflake.upperbound = upperbound;
    function getSequence(value) {
      return Number.parseInt(value.substring(8, 16), 16) & MAX_SEQ;
    }
    Snowflake.getSequence = getSequence;
    function getTimestamp(value) {
      const hi = Number.parseInt(value.substring(0, 8), 16);
      const lo = Number.parseInt(value.substring(8, 16), 16);
      return hi * 1024 + (lo >>> 22) + EPOCH;
    }
    Snowflake.getTimestamp = getTimestamp;
    function getDate(value) {
      return new Date(getTimestamp(value));
    }
    Snowflake.getDate = getDate;
  })(Snowflake ||= {});
});

// src/tools/tool-errors.ts
function throwIfAborted(signal) {
  if (signal?.aborted) {
    const reason = signal.reason instanceof Error ? signal.reason : undefined;
    throw reason instanceof ToolAbortError ? reason : new ToolAbortError(undefined, { cause: signal.reason });
  }
}
var ToolError, ToolAbortError;
var init_tool_errors = __esm(() => {
  ToolError = class ToolError extends Error {
    context;
    constructor(message, context) {
      super(message);
      this.context = context;
      this.name = "ToolError";
    }
    render() {
      return this.message;
    }
  };
  ToolAbortError = class ToolAbortError extends Error {
    static MESSAGE = "Operation aborted";
    constructor(message = ToolAbortError.MESSAGE, options) {
      super(message, options);
      this.name = "ToolAbortError";
    }
  };
});

// src/eval/js/shared/helpers.ts
import * as path3 from "path";
function createHelpers(ctx) {
  return {
    read: async (rawPath, options = {}) => {
      const { filePath, file, size } = await resolveRegularFile(ctx, rawPath);
      let text = await file.text();
      const offset = typeof options.offset === "number" ? options.offset : 1;
      const limit = typeof options.limit === "number" ? options.limit : undefined;
      if (offset > 1 || limit !== undefined) {
        const lines = text.split(/\r?\n/);
        const start = Math.max(0, offset - 1);
        const end = limit !== undefined ? start + limit : lines.length;
        text = lines.slice(start, end).join(`
`);
      }
      ctx.emitStatus({ op: "read", path: filePath, bytes: size, chars: text.length });
      return text;
    },
    writeFile: async (rawPath, data) => {
      if (!isWriteData(data)) {
        throw new ToolError("write() expects string, Blob, ArrayBuffer, or TypedArray data");
      }
      const filePath = resolveHelperPath(ctx, rawPath, "write");
      if (typeof data === "string" || data instanceof Blob || data instanceof ArrayBuffer) {
        await Bun.write(filePath, data);
      } else {
        await Bun.write(filePath, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      }
      ctx.emitStatus({ op: "write", path: filePath, bytes: getDataSize(data) });
      return filePath;
    },
    env: (key, value) => {
      if (!key) {
        const merged = Object.fromEntries(Object.entries(getMergedEnv(ctx)).sort(([a], [b]) => a.localeCompare(b)));
        ctx.emitStatus({ op: "env", count: Object.keys(merged).length, keys: Object.keys(merged).slice(0, 20) });
        return merged;
      }
      if (value !== undefined) {
        ctx.env.set(key, value);
        ctx.emitStatus({ op: "env", key, value, action: "set" });
        return value;
      }
      const result = ctx.env.get(key) ?? Bun.env[key];
      ctx.emitStatus({ op: "env", key, value: result, action: "get" });
      return result;
    }
  };
}
function getMergedEnv(ctx) {
  const merged = {};
  for (const [key, value] of Object.entries(Bun.env)) {
    if (typeof value === "string")
      merged[key] = value;
  }
  for (const [key, value] of ctx.env)
    merged[key] = value;
  return merged;
}
function resolvePath(ctx, value) {
  if (path3.isAbsolute(value))
    return path3.normalize(value);
  return path3.resolve(ctx.cwd(), value);
}
function resolveHelperPath(ctx, rawPath, op) {
  const match = INTERNAL_URL_RE.exec(rawPath);
  if (!match)
    return resolvePath(ctx, rawPath);
  const scheme = match[1].toLowerCase();
  const root = ctx.localRoots()[scheme];
  if (!root) {
    throw new ToolError(`Protocol paths are not supported by ${op}(): ${rawPath}`);
  }
  return resolveUnderRoot(scheme, root, match[2], rawPath);
}
function resolveUnderRoot(scheme, root, rawRelative, rawPath) {
  let relative2;
  try {
    relative2 = decodeURIComponent(rawRelative.replaceAll("\\", "/"));
  } catch {
    throw new ToolError(`Invalid URL encoding in ${scheme}:// path: ${rawPath}`);
  }
  const rootPath = path3.resolve(root);
  if (relative2 === "")
    return rootPath;
  if (path3.isAbsolute(relative2)) {
    throw new ToolError(`Absolute paths are not allowed in ${scheme}:// URLs: ${rawPath}`);
  }
  const normalized = path3.normalize(relative2);
  if (normalized.startsWith("..") || normalized.includes("/../") || normalized.includes("/..")) {
    throw new ToolError(`Path traversal (..) is not allowed in ${scheme}:// URLs: ${rawPath}`);
  }
  const resolved = path3.resolve(rootPath, normalized);
  if (resolved !== rootPath && !resolved.startsWith(`${rootPath}${path3.sep}`)) {
    throw new ToolError(`${scheme}:// path escapes its root: ${rawPath}`);
  }
  return resolved;
}
async function resolveRegularFile(ctx, rawPath) {
  const filePath = resolveHelperPath(ctx, rawPath, "read");
  const file = Bun.file(filePath);
  const stat = await file.stat();
  if (stat.isDirectory()) {
    throw new ToolError(`Directory paths are not supported by read(): ${filePath}`);
  }
  return { filePath, file, size: stat.size };
}
function getDataSize(data) {
  if (typeof data === "string")
    return utf8Encoder.encode(data).byteLength;
  if (data instanceof Blob)
    return data.size;
  if (data instanceof ArrayBuffer)
    return data.byteLength;
  return data.byteLength;
}
function isWriteData(value) {
  return typeof value === "string" || value instanceof Blob || value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}
var utf8Encoder, INTERNAL_URL_RE;
var init_helpers = __esm(() => {
  init_tool_errors();
  utf8Encoder = new TextEncoder;
  INTERNAL_URL_RE = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i;
});

// src/eval/js/shared/indirect-eval.ts
function indirectEval(source, filename) {
  const withPragma = filename ? `${source}
//# sourceURL=${filename}` : source;
  const geval = globalThis.eval;
  return geval(withPragma);
}
async function awaitMaybePromise(value) {
  if (!value || typeof value !== "object" || typeof value.then !== "function") {
    return value;
  }
  return await value;
}

// ../../node_modules/@babel/parser/lib/index.js
var require_lib = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", {
    value: true
  });
  function _objectWithoutPropertiesLoose(r, e) {
    if (r == null)
      return {};
    var t = {};
    for (var n in r)
      if ({}.hasOwnProperty.call(r, n)) {
        if (e.indexOf(n) !== -1)
          continue;
        t[n] = r[n];
      }
    return t;
  }

  class Position {
    constructor(line, col, index) {
      this.line = undefined;
      this.column = undefined;
      this.index = undefined;
      this.line = line;
      this.column = col;
      this.index = index;
    }
  }

  class SourceLocation {
    constructor(start, end) {
      this.start = undefined;
      this.end = undefined;
      this.filename = undefined;
      this.identifierName = undefined;
      this.start = start;
      this.end = end;
    }
  }
  function createPositionWithColumnOffset(position, columnOffset) {
    const {
      line,
      column,
      index
    } = position;
    return new Position(line, column + columnOffset, index + columnOffset);
  }
  var code = "BABEL_PARSER_SOURCETYPE_MODULE_REQUIRED";
  var ModuleErrors = {
    ImportMetaOutsideModule: {
      message: `import.meta may appear only with 'sourceType: "module"'`,
      code
    },
    ImportOutsideModule: {
      message: `'import' and 'export' may appear only with 'sourceType: "module"'`,
      code
    }
  };
  var NodeDescriptions = {
    ArrayPattern: "array destructuring pattern",
    AssignmentExpression: "assignment expression",
    AssignmentPattern: "assignment expression",
    ArrowFunctionExpression: "arrow function expression",
    ConditionalExpression: "conditional expression",
    CatchClause: "catch clause",
    ForOfStatement: "for-of statement",
    ForInStatement: "for-in statement",
    ForStatement: "for-loop",
    FormalParameters: "function parameter list",
    Identifier: "identifier",
    ImportSpecifier: "import specifier",
    ImportDefaultSpecifier: "import default specifier",
    ImportNamespaceSpecifier: "import namespace specifier",
    ObjectPattern: "object destructuring pattern",
    ParenthesizedExpression: "parenthesized expression",
    RestElement: "rest element",
    UpdateExpression: {
      true: "prefix operation",
      false: "postfix operation"
    },
    VariableDeclarator: "variable declaration",
    YieldExpression: "yield expression"
  };
  var toNodeDescription = (node) => node.type === "UpdateExpression" ? NodeDescriptions.UpdateExpression[`${node.prefix}`] : NodeDescriptions[node.type];
  var StandardErrors = {
    AccessorIsGenerator: ({
      kind
    }) => `A ${kind}ter cannot be a generator.`,
    ArgumentsInClass: "'arguments' is only allowed in functions and class methods.",
    AsyncFunctionInSingleStatementContext: "Async functions can only be declared at the top level or inside a block.",
    AwaitBindingIdentifier: "Can not use 'await' as identifier inside an async function.",
    AwaitBindingIdentifierInStaticBlock: "Can not use 'await' as identifier inside a static block.",
    AwaitExpressionFormalParameter: "'await' is not allowed in async function parameters.",
    AwaitUsingNotInAsyncContext: "'await using' is only allowed within async functions and at the top levels of modules.",
    AwaitNotInAsyncContext: "'await' is only allowed within async functions and at the top levels of modules.",
    BadGetterArity: "A 'get' accessor must not have any formal parameters.",
    BadSetterArity: "A 'set' accessor must have exactly one formal parameter.",
    BadSetterRestParameter: "A 'set' accessor function argument must not be a rest parameter.",
    ConstructorClassField: "Classes may not have a field named 'constructor'.",
    ConstructorClassPrivateField: "Classes may not have a private field named '#constructor'.",
    ConstructorIsAccessor: "Class constructor may not be an accessor.",
    ConstructorIsAsync: "Constructor can't be an async function.",
    ConstructorIsGenerator: "Constructor can't be a generator.",
    DeclarationMissingInitializer: ({
      kind
    }) => `Missing initializer in ${kind} declaration.`,
    DecoratorArgumentsOutsideParentheses: "Decorator arguments must be moved inside parentheses: use '@(decorator(args))' instead of '@(decorator)(args)'.",
    DecoratorBeforeExport: "Decorators must be placed *before* the 'export' keyword. Remove the 'decoratorsBeforeExport: true' option to use the 'export @decorator class {}' syntax.",
    DecoratorsBeforeAfterExport: "Decorators can be placed *either* before or after the 'export' keyword, but not in both locations at the same time.",
    DecoratorConstructor: "Decorators can't be used with a constructor. Did you mean '@dec class { ... }'?",
    DecoratorExportClass: "Decorators must be placed *after* the 'export' keyword. Remove the 'decoratorsBeforeExport: false' option to use the '@decorator export class {}' syntax.",
    DecoratorSemicolon: "Decorators must not be followed by a semicolon.",
    DecoratorStaticBlock: "Decorators can't be used with a static block.",
    DeferImportRequiresNamespace: 'Only `import defer * as x from "./module"` is valid.',
    DeletePrivateField: "Deleting a private field is not allowed.",
    DestructureNamedImport: "ES2015 named imports do not destructure. Use another statement for destructuring after the import.",
    DuplicateConstructor: "Duplicate constructor in the same class.",
    DuplicateDefaultExport: "Only one default export allowed per module.",
    DuplicateExport: ({
      exportName
    }) => `\`${exportName}\` has already been exported. Exported identifiers must be unique.`,
    DuplicateProto: "Redefinition of __proto__ property.",
    DuplicateRegExpFlags: "Duplicate regular expression flag.",
    ElementAfterRest: "Rest element must be last element.",
    EscapedCharNotAnIdentifier: "Invalid Unicode escape.",
    ExportBindingIsString: ({
      localName,
      exportName
    }) => `A string literal cannot be used as an exported binding without \`from\`.
- Did you mean \`export { '${localName}' as '${exportName}' } from 'some-module'\`?`,
    ExportDefaultFromAsIdentifier: "'from' is not allowed as an identifier after 'export default'.",
    ForInOfLoopInitializer: ({
      type
    }) => `'${type === "ForInStatement" ? "for-in" : "for-of"}' loop variable declaration may not have an initializer.`,
    ForInUsing: "For-in loop may not start with 'using' declaration.",
    ForOfAsync: "The left-hand side of a for-of loop may not be 'async'.",
    ForOfLet: "The left-hand side of a for-of loop may not start with 'let'.",
    GeneratorInSingleStatementContext: "Generators can only be declared at the top level or inside a block.",
    IllegalBreakContinue: ({
      type
    }) => `Unsyntactic ${type === "BreakStatement" ? "break" : "continue"}.`,
    IllegalLanguageModeDirective: "Illegal 'use strict' directive in function with non-simple parameter list.",
    IllegalReturn: "'return' outside of function.",
    ImportAttributesUseAssert: "The `assert` keyword in import attributes is deprecated and it has been replaced by the `with` keyword. You can enable the `deprecatedImportAssert` parser plugin to suppress this error.",
    ImportBindingIsString: ({
      importName
    }) => `A string literal cannot be used as an imported binding.
- Did you mean \`import { "${importName}" as foo }\`?`,
    ImportCallArity: `\`import()\` requires exactly one or two arguments.`,
    ImportCallNotNewExpression: "Cannot use new with import(...).",
    ImportCallSpreadArgument: "`...` is not allowed in `import()`.",
    ImportJSONBindingNotDefault: "A JSON module can only be imported with `default`.",
    ImportReflectionHasAssertion: "`import module x` cannot have assertions.",
    ImportReflectionNotBinding: 'Only `import module x from "./module"` is valid.',
    IncompatibleRegExpUVFlags: "The 'u' and 'v' regular expression flags cannot be enabled at the same time.",
    InvalidBigIntLiteral: "Invalid BigIntLiteral.",
    InvalidCodePoint: "Code point out of bounds.",
    InvalidCoverDiscardElement: "'void' must be followed by an expression when not used in a binding position.",
    InvalidCoverInitializedName: "Invalid shorthand property initializer.",
    InvalidDecimal: "Invalid decimal.",
    InvalidDigit: ({
      radix
    }) => `Expected number in radix ${radix}.`,
    InvalidEscapeSequence: "Bad character escape sequence.",
    InvalidEscapeSequenceTemplate: "Invalid escape sequence in template.",
    InvalidEscapedReservedWord: ({
      reservedWord
    }) => `Escape sequence in keyword ${reservedWord}.`,
    InvalidIdentifier: ({
      identifierName
    }) => `Invalid identifier ${identifierName}.`,
    InvalidLhs: ({
      ancestor
    }) => `Invalid left-hand side in ${toNodeDescription(ancestor)}.`,
    InvalidLhsBinding: ({
      ancestor
    }) => `Binding invalid left-hand side in ${toNodeDescription(ancestor)}.`,
    InvalidLhsOptionalChaining: ({
      ancestor
    }) => `Invalid optional chaining in the left-hand side of ${toNodeDescription(ancestor)}.`,
    InvalidNumber: "Invalid number.",
    InvalidOrMissingExponent: "Floating-point numbers require a valid exponent after the 'e'.",
    InvalidOrUnexpectedToken: ({
      unexpected
    }) => `Unexpected character '${unexpected}'.`,
    InvalidParenthesizedAssignment: "Invalid parenthesized assignment pattern.",
    InvalidPrivateFieldResolution: ({
      identifierName
    }) => `Private name #${identifierName} is not defined.`,
    InvalidPropertyBindingPattern: "Binding member expression.",
    InvalidRecordProperty: "Only properties and spread elements are allowed in record definitions.",
    InvalidRestAssignmentPattern: "Invalid rest operator's argument.",
    LabelRedeclaration: ({
      labelName
    }) => `Label '${labelName}' is already declared.`,
    LetInLexicalBinding: "'let' is disallowed as a lexically bound name.",
    LineTerminatorBeforeArrow: "No line break is allowed before '=>'.",
    MalformedRegExpFlags: "Invalid regular expression flag.",
    MissingClassName: "A class name is required.",
    MissingEqInAssignment: "Only '=' operator can be used for specifying default value.",
    MissingSemicolon: "Missing semicolon.",
    MissingPlugin: ({
      missingPlugin
    }) => `This experimental syntax requires enabling the parser plugin: ${missingPlugin.map((name) => JSON.stringify(name)).join(", ")}.`,
    MissingOneOfPlugins: ({
      missingPlugin
    }) => `This experimental syntax requires enabling one of the following parser plugin(s): ${missingPlugin.map((name) => JSON.stringify(name)).join(", ")}.`,
    MissingUnicodeEscape: "Expecting Unicode escape sequence \\uXXXX.",
    MixingCoalesceWithLogical: "Nullish coalescing operator(??) requires parens when mixing with logical operators.",
    ModuleAttributeDifferentFromType: "The only accepted module attribute is `type`.",
    ModuleAttributeInvalidValue: "Only string literals are allowed as module attribute values.",
    ModuleAttributesWithDuplicateKeys: ({
      key
    }) => `Duplicate key "${key}" is not allowed in module attributes.`,
    ModuleExportNameHasLoneSurrogate: ({
      surrogateCharCode
    }) => `An export name cannot include a lone surrogate, found '\\u${surrogateCharCode.toString(16)}'.`,
    ModuleExportUndefined: ({
      localName
    }) => `Export '${localName}' is not defined.`,
    MultipleDefaultsInSwitch: "Multiple default clauses.",
    NewlineAfterThrow: "Illegal newline after throw.",
    NoCatchOrFinally: "Missing catch or finally clause.",
    NumberIdentifier: "Identifier directly after number.",
    NumericSeparatorInEscapeSequence: "Numeric separators are not allowed inside unicode escape sequences or hex escape sequences.",
    ObsoleteAwaitStar: "'await*' has been removed from the async functions proposal. Use Promise.all() instead.",
    OptionalChainingNoNew: "Constructors in/after an Optional Chain are not allowed.",
    OptionalChainingNoTemplate: "Tagged Template Literals are not allowed in optionalChain.",
    OverrideOnConstructor: "'override' modifier cannot appear on a constructor declaration.",
    ParamDupe: "Argument name clash.",
    PatternHasAccessor: "Object pattern can't contain getter or setter.",
    PatternHasMethod: "Object pattern can't contain methods.",
    PrivateInExpectedIn: ({
      identifierName
    }) => `Private names are only allowed in property accesses (\`obj.#${identifierName}\`) or in \`in\` expressions (\`#${identifierName} in obj\`).`,
    PrivateNameRedeclaration: ({
      identifierName
    }) => `Duplicate private name #${identifierName}.`,
    RecordExpressionBarIncorrectEndSyntaxType: "Record expressions ending with '|}' are only allowed when the 'syntaxType' option of the 'recordAndTuple' plugin is set to 'bar'.",
    RecordExpressionBarIncorrectStartSyntaxType: "Record expressions starting with '{|' are only allowed when the 'syntaxType' option of the 'recordAndTuple' plugin is set to 'bar'.",
    RecordExpressionHashIncorrectStartSyntaxType: "Record expressions starting with '#{' are only allowed when the 'syntaxType' option of the 'recordAndTuple' plugin is set to 'hash'.",
    RecordNoProto: "'__proto__' is not allowed in Record expressions.",
    RestTrailingComma: "Unexpected trailing comma after rest element.",
    SloppyFunction: "In non-strict mode code, functions can only be declared at top level or inside a block.",
    SloppyFunctionAnnexB: "In non-strict mode code, functions can only be declared at top level, inside a block, or as the body of an if statement.",
    SourcePhaseImportRequiresDefault: 'Only `import source x from "./module"` is valid.',
    StaticPrototype: "Classes may not have static property named prototype.",
    SuperNotAllowed: "`super()` is only valid inside a class constructor of a subclass. Maybe a typo in the method name ('constructor') or not extending another class?",
    SuperPrivateField: "Private fields can't be accessed on super.",
    TrailingDecorator: "Decorators must be attached to a class element.",
    TupleExpressionBarIncorrectEndSyntaxType: "Tuple expressions ending with '|]' are only allowed when the 'syntaxType' option of the 'recordAndTuple' plugin is set to 'bar'.",
    TupleExpressionBarIncorrectStartSyntaxType: "Tuple expressions starting with '[|' are only allowed when the 'syntaxType' option of the 'recordAndTuple' plugin is set to 'bar'.",
    TupleExpressionHashIncorrectStartSyntaxType: "Tuple expressions starting with '#[' are only allowed when the 'syntaxType' option of the 'recordAndTuple' plugin is set to 'hash'.",
    UnexpectedArgumentPlaceholder: "Unexpected argument placeholder.",
    UnexpectedAwaitAfterPipelineBody: 'Unexpected "await" after pipeline body; await must have parentheses in minimal proposal.',
    UnexpectedDigitAfterHash: "Unexpected digit after hash token.",
    UnexpectedImportExport: "'import' and 'export' may only appear at the top level.",
    UnexpectedKeyword: ({
      keyword
    }) => `Unexpected keyword '${keyword}'.`,
    UnexpectedLeadingDecorator: "Leading decorators must be attached to a class declaration.",
    UnexpectedLexicalDeclaration: "Lexical declaration cannot appear in a single-statement context.",
    UnexpectedNewTarget: "`new.target` can only be used in functions or class properties.",
    UnexpectedNumericSeparator: "A numeric separator is only allowed between two digits.",
    UnexpectedPrivateField: "Unexpected private name.",
    UnexpectedReservedWord: ({
      reservedWord
    }) => `Unexpected reserved word '${reservedWord}'.`,
    UnexpectedSuper: "'super' is only allowed in object methods and classes.",
    UnexpectedToken: ({
      expected,
      unexpected
    }) => `Unexpected token${unexpected ? ` '${unexpected}'.` : ""}${expected ? `, expected "${expected}"` : ""}`,
    UnexpectedTokenUnaryExponentiation: "Illegal expression. Wrap left hand side or entire exponentiation in parentheses.",
    UnexpectedUsingDeclaration: "Using declaration cannot appear in the top level when source type is `script` or in the bare case statement.",
    UnexpectedVoidPattern: "Unexpected void binding.",
    UnsupportedBind: "Binding should be performed on object property.",
    UnsupportedDecoratorExport: "A decorated export must export a class declaration.",
    UnsupportedDefaultExport: "Only expressions, functions or classes are allowed as the `default` export.",
    UnsupportedImport: "`import` can only be used in `import()` or `import.meta`.",
    UnsupportedMetaProperty: ({
      target,
      onlyValidPropertyName
    }) => `The only valid meta property for ${target} is ${target}.${onlyValidPropertyName}.`,
    UnsupportedParameterDecorator: "Decorators cannot be used to decorate parameters.",
    UnsupportedPropertyDecorator: "Decorators cannot be used to decorate object literal properties.",
    UnsupportedSuper: "'super' can only be used with function calls (i.e. super()) or in property accesses (i.e. super.prop or super[prop]).",
    UnterminatedComment: "Unterminated comment.",
    UnterminatedRegExp: "Unterminated regular expression.",
    UnterminatedString: "Unterminated string constant.",
    UnterminatedTemplate: "Unterminated template.",
    UsingDeclarationExport: "Using declaration cannot be exported.",
    UsingDeclarationHasBindingPattern: "Using declaration cannot have destructuring patterns.",
    VarRedeclaration: ({
      identifierName
    }) => `Identifier '${identifierName}' has already been declared.`,
    VoidPatternCatchClauseParam: "A void binding can not be the catch clause parameter. Use `try { ... } catch { ... }` if you want to discard the caught error.",
    VoidPatternInitializer: "A void binding may not have an initializer.",
    YieldBindingIdentifier: "Can not use 'yield' as identifier inside a generator.",
    YieldInParameter: "Yield expression is not allowed in formal parameters.",
    YieldNotInGeneratorFunction: "'yield' is only allowed within generator functions.",
    ZeroDigitNumericSeparator: "Numeric separator can not be used after leading 0."
  };
  var StrictModeErrors = {
    StrictDelete: "Deleting local variable in strict mode.",
    StrictEvalArguments: ({
      referenceName
    }) => `Assigning to '${referenceName}' in strict mode.`,
    StrictEvalArgumentsBinding: ({
      bindingName
    }) => `Binding '${bindingName}' in strict mode.`,
    StrictFunction: "In strict mode code, functions can only be declared at top level or inside a block.",
    StrictNumericEscape: "The only valid numeric escape in strict mode is '\\0'.",
    StrictOctalLiteral: "Legacy octal literals are not allowed in strict mode.",
    StrictWith: "'with' in strict mode."
  };
  var ParseExpressionErrors = {
    ParseExpressionEmptyInput: "Unexpected parseExpression() input: The input is empty or contains only comments.",
    ParseExpressionExpectsEOF: ({
      unexpected
    }) => `Unexpected parseExpression() input: The input should contain exactly one expression, but the first expression is followed by the unexpected character \`${String.fromCodePoint(unexpected)}\`.`
  };
  var UnparenthesizedPipeBodyDescriptions = new Set(["ArrowFunctionExpression", "AssignmentExpression", "ConditionalExpression", "YieldExpression"]);
  var PipelineOperatorErrors = Object.assign({
    PipeBodyIsTighter: "Unexpected yield after pipeline body; any yield expression acting as Hack-style pipe body must be parenthesized due to its loose operator precedence.",
    PipeTopicRequiresHackPipes: 'Topic reference is used, but the pipelineOperator plugin was not passed a "proposal": "hack" or "smart" option.',
    PipeTopicUnbound: "Topic reference is unbound; it must be inside a pipe body.",
    PipeTopicUnconfiguredToken: ({
      token
    }) => `Invalid topic token ${token}. In order to use ${token} as a topic reference, the pipelineOperator plugin must be configured with { "proposal": "hack", "topicToken": "${token}" }.`,
    PipeTopicUnused: "Hack-style pipe body does not contain a topic reference; Hack-style pipes must use topic at least once.",
    PipeUnparenthesizedBody: ({
      type
    }) => `Hack-style pipe body cannot be an unparenthesized ${toNodeDescription({
      type
    })}; please wrap it in parentheses.`
  }, {
    PipelineBodyNoArrow: 'Unexpected arrow "=>" after pipeline body; arrow function in pipeline body must be parenthesized.',
    PipelineBodySequenceExpression: "Pipeline body may not be a comma-separated sequence expression.",
    PipelineHeadSequenceExpression: "Pipeline head should not be a comma-separated sequence expression.",
    PipelineTopicUnused: "Pipeline is in topic style but does not use topic reference.",
    PrimaryTopicNotAllowed: "Topic reference was used in a lexical context without topic binding.",
    PrimaryTopicRequiresSmartPipeline: 'Topic reference is used, but the pipelineOperator plugin was not passed a "proposal": "hack" or "smart" option.'
  });
  var _excluded = ["message"];
  function defineHidden(obj, key, value) {
    Object.defineProperty(obj, key, {
      enumerable: false,
      configurable: true,
      value
    });
  }
  function toParseErrorConstructor({
    toMessage,
    code: code2,
    reasonCode,
    syntaxPlugin
  }) {
    const hasMissingPlugin = reasonCode === "MissingPlugin" || reasonCode === "MissingOneOfPlugins";
    const oldReasonCodes = {
      AccessorCannotDeclareThisParameter: "AccesorCannotDeclareThisParameter",
      AccessorCannotHaveTypeParameters: "AccesorCannotHaveTypeParameters",
      ConstInitializerMustBeStringOrNumericLiteralOrLiteralEnumReference: "ConstInitiailizerMustBeStringOrNumericLiteralOrLiteralEnumReference",
      SetAccessorCannotHaveOptionalParameter: "SetAccesorCannotHaveOptionalParameter",
      SetAccessorCannotHaveRestParameter: "SetAccesorCannotHaveRestParameter",
      SetAccessorCannotHaveReturnType: "SetAccesorCannotHaveReturnType"
    };
    if (oldReasonCodes[reasonCode]) {
      reasonCode = oldReasonCodes[reasonCode];
    }
    return function constructor(loc, details) {
      const error2 = new SyntaxError;
      error2.code = code2;
      error2.reasonCode = reasonCode;
      error2.loc = loc;
      error2.pos = loc.index;
      error2.syntaxPlugin = syntaxPlugin;
      if (hasMissingPlugin) {
        error2.missingPlugin = details.missingPlugin;
      }
      defineHidden(error2, "clone", function clone(overrides = {}) {
        var _overrides$loc;
        const {
          line,
          column,
          index
        } = (_overrides$loc = overrides.loc) != null ? _overrides$loc : loc;
        return constructor(new Position(line, column, index), Object.assign({}, details, overrides.details));
      });
      defineHidden(error2, "details", details);
      Object.defineProperty(error2, "message", {
        configurable: true,
        get() {
          const message = `${toMessage(details)} (${loc.line}:${loc.column})`;
          this.message = message;
          return message;
        },
        set(value) {
          Object.defineProperty(this, "message", {
            value,
            writable: true
          });
        }
      });
      return error2;
    };
  }
  function ParseErrorEnum(argument, syntaxPlugin) {
    if (Array.isArray(argument)) {
      return (parseErrorTemplates) => ParseErrorEnum(parseErrorTemplates, argument[0]);
    }
    const ParseErrorConstructors = {};
    for (const reasonCode of Object.keys(argument)) {
      const template = argument[reasonCode];
      const _ref = typeof template === "string" ? {
        message: () => template
      } : typeof template === "function" ? {
        message: template
      } : template, {
        message
      } = _ref, rest = _objectWithoutPropertiesLoose(_ref, _excluded);
      const toMessage = typeof message === "string" ? () => message : message;
      ParseErrorConstructors[reasonCode] = toParseErrorConstructor(Object.assign({
        code: "BABEL_PARSER_SYNTAX_ERROR",
        reasonCode,
        toMessage
      }, syntaxPlugin ? {
        syntaxPlugin
      } : {}, rest));
    }
    return ParseErrorConstructors;
  }
  var Errors = Object.assign({}, ParseErrorEnum(ModuleErrors), ParseErrorEnum(StandardErrors), ParseErrorEnum(StrictModeErrors), ParseErrorEnum(ParseExpressionErrors), ParseErrorEnum`pipelineOperator`(PipelineOperatorErrors));
  function createDefaultOptions() {
    return {
      sourceType: "script",
      sourceFilename: undefined,
      startIndex: 0,
      startColumn: 0,
      startLine: 1,
      allowAwaitOutsideFunction: false,
      allowReturnOutsideFunction: false,
      allowNewTargetOutsideFunction: false,
      allowImportExportEverywhere: false,
      allowSuperOutsideMethod: false,
      allowUndeclaredExports: false,
      allowYieldOutsideFunction: false,
      plugins: [],
      strictMode: undefined,
      ranges: false,
      tokens: false,
      createImportExpressions: false,
      createParenthesizedExpressions: false,
      errorRecovery: false,
      attachComment: true,
      annexB: true
    };
  }
  function getOptions(opts) {
    const options = createDefaultOptions();
    if (opts == null) {
      return options;
    }
    if (opts.annexB != null && opts.annexB !== false) {
      throw new Error("The `annexB` option can only be set to `false`.");
    }
    for (const key of Object.keys(options)) {
      if (opts[key] != null)
        options[key] = opts[key];
    }
    if (options.startLine === 1) {
      if (opts.startIndex == null && options.startColumn > 0) {
        options.startIndex = options.startColumn;
      } else if (opts.startColumn == null && options.startIndex > 0) {
        options.startColumn = options.startIndex;
      }
    } else if (opts.startColumn == null || opts.startIndex == null) {
      if (opts.startIndex != null) {
        throw new Error("With a `startLine > 1` you must also specify `startIndex` and `startColumn`.");
      }
    }
    if (options.sourceType === "commonjs") {
      if (opts.allowAwaitOutsideFunction != null) {
        throw new Error("The `allowAwaitOutsideFunction` option cannot be used with `sourceType: 'commonjs'`.");
      }
      if (opts.allowReturnOutsideFunction != null) {
        throw new Error("`sourceType: 'commonjs'` implies `allowReturnOutsideFunction: true`, please remove the `allowReturnOutsideFunction` option or use `sourceType: 'script'`.");
      }
      if (opts.allowNewTargetOutsideFunction != null) {
        throw new Error("`sourceType: 'commonjs'` implies `allowNewTargetOutsideFunction: true`, please remove the `allowNewTargetOutsideFunction` option or use `sourceType: 'script'`.");
      }
    }
    return options;
  }
  var {
    defineProperty
  } = Object;
  var toUnenumerable = (object, key) => {
    if (object) {
      defineProperty(object, key, {
        enumerable: false,
        value: object[key]
      });
    }
  };
  function toESTreeLocation(node) {
    toUnenumerable(node.loc.start, "index");
    toUnenumerable(node.loc.end, "index");
    return node;
  }
  var estree = (superClass) => class ESTreeParserMixin extends superClass {
    parse() {
      const file = toESTreeLocation(super.parse());
      if (this.optionFlags & 256) {
        file.tokens = file.tokens.map(toESTreeLocation);
      }
      return file;
    }
    parseRegExpLiteral({
      pattern,
      flags
    }) {
      let regex = null;
      try {
        regex = new RegExp(pattern, flags);
      } catch (_) {}
      const node = this.estreeParseLiteral(regex);
      node.regex = {
        pattern,
        flags
      };
      return node;
    }
    parseBigIntLiteral(value) {
      let bigInt;
      try {
        bigInt = BigInt(value);
      } catch (_unused) {
        bigInt = null;
      }
      const node = this.estreeParseLiteral(bigInt);
      node.bigint = String(node.value || value);
      return node;
    }
    parseDecimalLiteral(value) {
      const decimal = null;
      const node = this.estreeParseLiteral(decimal);
      node.decimal = String(node.value || value);
      return node;
    }
    estreeParseLiteral(value) {
      return this.parseLiteral(value, "Literal");
    }
    parseStringLiteral(value) {
      return this.estreeParseLiteral(value);
    }
    parseNumericLiteral(value) {
      return this.estreeParseLiteral(value);
    }
    parseNullLiteral() {
      return this.estreeParseLiteral(null);
    }
    parseBooleanLiteral(value) {
      return this.estreeParseLiteral(value);
    }
    estreeParseChainExpression(node, endLoc) {
      const chain = this.startNodeAtNode(node);
      chain.expression = node;
      return this.finishNodeAt(chain, "ChainExpression", endLoc);
    }
    directiveToStmt(directive) {
      const expression = directive.value;
      delete directive.value;
      this.castNodeTo(expression, "Literal");
      expression.raw = expression.extra.raw;
      expression.value = expression.extra.expressionValue;
      const stmt = this.castNodeTo(directive, "ExpressionStatement");
      stmt.expression = expression;
      stmt.directive = expression.extra.rawValue;
      delete expression.extra;
      return stmt;
    }
    fillOptionalPropertiesForTSESLint(node) {}
    cloneEstreeStringLiteral(node) {
      const {
        start,
        end,
        loc,
        range,
        raw,
        value
      } = node;
      const cloned = Object.create(node.constructor.prototype);
      cloned.type = "Literal";
      cloned.start = start;
      cloned.end = end;
      cloned.loc = loc;
      cloned.range = range;
      cloned.raw = raw;
      cloned.value = value;
      return cloned;
    }
    initFunction(node, isAsync) {
      super.initFunction(node, isAsync);
      node.expression = false;
    }
    checkDeclaration(node) {
      if (node != null && this.isObjectProperty(node)) {
        this.checkDeclaration(node.value);
      } else {
        super.checkDeclaration(node);
      }
    }
    getObjectOrClassMethodParams(method) {
      return method.value.params;
    }
    isValidDirective(stmt) {
      var _stmt$expression$extr;
      return stmt.type === "ExpressionStatement" && stmt.expression.type === "Literal" && typeof stmt.expression.value === "string" && !((_stmt$expression$extr = stmt.expression.extra) != null && _stmt$expression$extr.parenthesized);
    }
    parseBlockBody(node, allowDirectives, topLevel, end, afterBlockParse) {
      super.parseBlockBody(node, allowDirectives, topLevel, end, afterBlockParse);
      const directiveStatements = node.directives.map((d) => this.directiveToStmt(d));
      node.body = directiveStatements.concat(node.body);
      delete node.directives;
    }
    parsePrivateName() {
      const node = super.parsePrivateName();
      if (!this.getPluginOption("estree", "classFeatures")) {
        return node;
      }
      return this.convertPrivateNameToPrivateIdentifier(node);
    }
    convertPrivateNameToPrivateIdentifier(node) {
      const name = super.getPrivateNameSV(node);
      delete node.id;
      node.name = name;
      return this.castNodeTo(node, "PrivateIdentifier");
    }
    isPrivateName(node) {
      if (!this.getPluginOption("estree", "classFeatures")) {
        return super.isPrivateName(node);
      }
      return node.type === "PrivateIdentifier";
    }
    getPrivateNameSV(node) {
      if (!this.getPluginOption("estree", "classFeatures")) {
        return super.getPrivateNameSV(node);
      }
      return node.name;
    }
    parseLiteral(value, type) {
      const node = super.parseLiteral(value, type);
      node.raw = node.extra.raw;
      delete node.extra;
      return node;
    }
    parseFunctionBody(node, allowExpression, isMethod = false) {
      super.parseFunctionBody(node, allowExpression, isMethod);
      node.expression = node.body.type !== "BlockStatement";
    }
    parseMethod(node, isGenerator, isAsync, isConstructor, allowDirectSuper, type, inClassScope = false) {
      let funcNode = this.startNode();
      funcNode.kind = node.kind;
      funcNode = super.parseMethod(funcNode, isGenerator, isAsync, isConstructor, allowDirectSuper, type, inClassScope);
      delete funcNode.kind;
      const {
        typeParameters
      } = node;
      if (typeParameters) {
        delete node.typeParameters;
        funcNode.typeParameters = typeParameters;
        this.resetStartLocationFromNode(funcNode, typeParameters);
      }
      const valueNode = this.castNodeTo(funcNode, "FunctionExpression");
      node.value = valueNode;
      if (type === "ClassPrivateMethod") {
        node.computed = false;
      }
      if (type === "ObjectMethod") {
        if (node.kind === "method") {
          node.kind = "init";
        }
        node.shorthand = false;
        return this.finishNode(node, "Property");
      } else {
        return this.finishNode(node, "MethodDefinition");
      }
    }
    nameIsConstructor(key) {
      if (key.type === "Literal")
        return key.value === "constructor";
      return super.nameIsConstructor(key);
    }
    parseClassProperty(...args) {
      const propertyNode = super.parseClassProperty(...args);
      if (!this.getPluginOption("estree", "classFeatures")) {
        return propertyNode;
      }
      this.castNodeTo(propertyNode, "PropertyDefinition");
      return propertyNode;
    }
    parseClassPrivateProperty(...args) {
      const propertyNode = super.parseClassPrivateProperty(...args);
      if (!this.getPluginOption("estree", "classFeatures")) {
        return propertyNode;
      }
      this.castNodeTo(propertyNode, "PropertyDefinition");
      propertyNode.computed = false;
      return propertyNode;
    }
    parseClassAccessorProperty(node) {
      const accessorPropertyNode = super.parseClassAccessorProperty(node);
      if (!this.getPluginOption("estree", "classFeatures")) {
        return accessorPropertyNode;
      }
      if (accessorPropertyNode.abstract && this.hasPlugin("typescript")) {
        delete accessorPropertyNode.abstract;
        this.castNodeTo(accessorPropertyNode, "TSAbstractAccessorProperty");
      } else {
        this.castNodeTo(accessorPropertyNode, "AccessorProperty");
      }
      return accessorPropertyNode;
    }
    parseObjectProperty(prop, startLoc, isPattern, refExpressionErrors) {
      const node = super.parseObjectProperty(prop, startLoc, isPattern, refExpressionErrors);
      if (node) {
        node.kind = "init";
        this.castNodeTo(node, "Property");
      }
      return node;
    }
    finishObjectProperty(node) {
      node.kind = "init";
      return this.finishNode(node, "Property");
    }
    isValidLVal(type, disallowCallExpression, isUnparenthesizedInAssign, binding) {
      return type === "Property" ? "value" : super.isValidLVal(type, disallowCallExpression, isUnparenthesizedInAssign, binding);
    }
    isAssignable(node, isBinding) {
      if (node != null && this.isObjectProperty(node)) {
        return this.isAssignable(node.value, isBinding);
      }
      return super.isAssignable(node, isBinding);
    }
    toAssignable(node, isLHS = false) {
      if (node != null && this.isObjectProperty(node)) {
        const {
          key,
          value
        } = node;
        if (this.isPrivateName(key)) {
          this.classScope.usePrivateName(this.getPrivateNameSV(key), key.loc.start);
        }
        this.toAssignable(value, isLHS);
      } else {
        super.toAssignable(node, isLHS);
      }
    }
    toAssignableObjectExpressionProp(prop, isLast, isLHS) {
      if (prop.type === "Property" && (prop.kind === "get" || prop.kind === "set")) {
        this.raise(Errors.PatternHasAccessor, prop.key);
      } else if (prop.type === "Property" && prop.method) {
        this.raise(Errors.PatternHasMethod, prop.key);
      } else {
        super.toAssignableObjectExpressionProp(prop, isLast, isLHS);
      }
    }
    finishCallExpression(unfinished, optional) {
      const node = super.finishCallExpression(unfinished, optional);
      if (node.callee.type === "Import") {
        var _ref, _ref2;
        this.castNodeTo(node, "ImportExpression");
        node.source = node.arguments[0];
        node.options = (_ref = node.arguments[1]) != null ? _ref : null;
        node.attributes = (_ref2 = node.arguments[1]) != null ? _ref2 : null;
        delete node.arguments;
        delete node.callee;
      } else if (node.type === "OptionalCallExpression") {
        this.castNodeTo(node, "CallExpression");
      } else {
        node.optional = false;
      }
      return node;
    }
    toReferencedArguments(node) {
      if (node.type === "ImportExpression") {
        return;
      }
      super.toReferencedArguments(node);
    }
    parseExport(unfinished, decorators) {
      const exportStartLoc = this.state.lastTokStartLoc;
      const node = super.parseExport(unfinished, decorators);
      switch (node.type) {
        case "ExportAllDeclaration":
          node.exported = null;
          break;
        case "ExportNamedDeclaration":
          if (node.specifiers.length === 1 && node.specifiers[0].type === "ExportNamespaceSpecifier") {
            this.castNodeTo(node, "ExportAllDeclaration");
            node.exported = node.specifiers[0].exported;
            delete node.specifiers;
          }
        case "ExportDefaultDeclaration":
          {
            var _declaration$decorato;
            const {
              declaration
            } = node;
            if ((declaration == null ? undefined : declaration.type) === "ClassDeclaration" && ((_declaration$decorato = declaration.decorators) == null ? undefined : _declaration$decorato.length) > 0 && declaration.start === node.start) {
              this.resetStartLocation(node, exportStartLoc);
            }
          }
          break;
      }
      return node;
    }
    stopParseSubscript(base, state) {
      const node = super.stopParseSubscript(base, state);
      if (state.optionalChainMember) {
        return this.estreeParseChainExpression(node, base.loc.end);
      }
      return node;
    }
    parseMember(base, startLoc, state, computed, optional) {
      const node = super.parseMember(base, startLoc, state, computed, optional);
      if (node.type === "OptionalMemberExpression") {
        this.castNodeTo(node, "MemberExpression");
      } else {
        node.optional = false;
      }
      return node;
    }
    isOptionalMemberExpression(node) {
      if (node.type === "ChainExpression") {
        return node.expression.type === "MemberExpression";
      }
      return super.isOptionalMemberExpression(node);
    }
    hasPropertyAsPrivateName(node) {
      if (node.type === "ChainExpression") {
        node = node.expression;
      }
      return super.hasPropertyAsPrivateName(node);
    }
    isObjectProperty(node) {
      return node.type === "Property" && node.kind === "init" && !node.method;
    }
    isObjectMethod(node) {
      return node.type === "Property" && (node.method || node.kind === "get" || node.kind === "set");
    }
    castNodeTo(node, type) {
      const result = super.castNodeTo(node, type);
      this.fillOptionalPropertiesForTSESLint(result);
      return result;
    }
    cloneIdentifier(node) {
      const cloned = super.cloneIdentifier(node);
      this.fillOptionalPropertiesForTSESLint(cloned);
      return cloned;
    }
    cloneStringLiteral(node) {
      if (node.type === "Literal") {
        return this.cloneEstreeStringLiteral(node);
      }
      return super.cloneStringLiteral(node);
    }
    finishNodeAt(node, type, endLoc) {
      return toESTreeLocation(super.finishNodeAt(node, type, endLoc));
    }
    finishNode(node, type) {
      const result = super.finishNode(node, type);
      this.fillOptionalPropertiesForTSESLint(result);
      return result;
    }
    resetStartLocation(node, startLoc) {
      super.resetStartLocation(node, startLoc);
      toESTreeLocation(node);
    }
    resetEndLocation(node, endLoc = this.state.lastTokEndLoc) {
      super.resetEndLocation(node, endLoc);
      toESTreeLocation(node);
    }
  };

  class TokContext {
    constructor(token, preserveSpace) {
      this.token = undefined;
      this.preserveSpace = undefined;
      this.token = token;
      this.preserveSpace = !!preserveSpace;
    }
  }
  var types = {
    brace: new TokContext("{"),
    j_oTag: new TokContext("<tag"),
    j_cTag: new TokContext("</tag"),
    j_expr: new TokContext("<tag>...</tag>", true)
  };
  types.template = new TokContext("`", true);
  var beforeExpr = true;
  var startsExpr = true;
  var isLoop = true;
  var isAssign = true;
  var prefix = true;
  var postfix = true;

  class ExportedTokenType {
    constructor(label, conf = {}) {
      this.label = undefined;
      this.keyword = undefined;
      this.beforeExpr = undefined;
      this.startsExpr = undefined;
      this.rightAssociative = undefined;
      this.isLoop = undefined;
      this.isAssign = undefined;
      this.prefix = undefined;
      this.postfix = undefined;
      this.binop = undefined;
      this.label = label;
      this.keyword = conf.keyword;
      this.beforeExpr = !!conf.beforeExpr;
      this.startsExpr = !!conf.startsExpr;
      this.rightAssociative = !!conf.rightAssociative;
      this.isLoop = !!conf.isLoop;
      this.isAssign = !!conf.isAssign;
      this.prefix = !!conf.prefix;
      this.postfix = !!conf.postfix;
      this.binop = conf.binop != null ? conf.binop : null;
      this.updateContext = null;
    }
  }
  var keywords$1 = new Map;
  function createKeyword(name, options = {}) {
    options.keyword = name;
    const token = createToken(name, options);
    keywords$1.set(name, token);
    return token;
  }
  function createBinop(name, binop) {
    return createToken(name, {
      beforeExpr,
      binop
    });
  }
  var tokenTypeCounter = -1;
  var tokenTypes = [];
  var tokenLabels = [];
  var tokenBinops = [];
  var tokenBeforeExprs = [];
  var tokenStartsExprs = [];
  var tokenPrefixes = [];
  function createToken(name, options = {}) {
    var _options$binop, _options$beforeExpr, _options$startsExpr, _options$prefix;
    ++tokenTypeCounter;
    tokenLabels.push(name);
    tokenBinops.push((_options$binop = options.binop) != null ? _options$binop : -1);
    tokenBeforeExprs.push((_options$beforeExpr = options.beforeExpr) != null ? _options$beforeExpr : false);
    tokenStartsExprs.push((_options$startsExpr = options.startsExpr) != null ? _options$startsExpr : false);
    tokenPrefixes.push((_options$prefix = options.prefix) != null ? _options$prefix : false);
    tokenTypes.push(new ExportedTokenType(name, options));
    return tokenTypeCounter;
  }
  function createKeywordLike(name, options = {}) {
    var _options$binop2, _options$beforeExpr2, _options$startsExpr2, _options$prefix2;
    ++tokenTypeCounter;
    keywords$1.set(name, tokenTypeCounter);
    tokenLabels.push(name);
    tokenBinops.push((_options$binop2 = options.binop) != null ? _options$binop2 : -1);
    tokenBeforeExprs.push((_options$beforeExpr2 = options.beforeExpr) != null ? _options$beforeExpr2 : false);
    tokenStartsExprs.push((_options$startsExpr2 = options.startsExpr) != null ? _options$startsExpr2 : false);
    tokenPrefixes.push((_options$prefix2 = options.prefix) != null ? _options$prefix2 : false);
    tokenTypes.push(new ExportedTokenType("name", options));
    return tokenTypeCounter;
  }
  var tt = {
    bracketL: createToken("[", {
      beforeExpr,
      startsExpr
    }),
    bracketHashL: createToken("#[", {
      beforeExpr,
      startsExpr
    }),
    bracketBarL: createToken("[|", {
      beforeExpr,
      startsExpr
    }),
    bracketR: createToken("]"),
    bracketBarR: createToken("|]"),
    braceL: createToken("{", {
      beforeExpr,
      startsExpr
    }),
    braceBarL: createToken("{|", {
      beforeExpr,
      startsExpr
    }),
    braceHashL: createToken("#{", {
      beforeExpr,
      startsExpr
    }),
    braceR: createToken("}"),
    braceBarR: createToken("|}"),
    parenL: createToken("(", {
      beforeExpr,
      startsExpr
    }),
    parenR: createToken(")"),
    comma: createToken(",", {
      beforeExpr
    }),
    semi: createToken(";", {
      beforeExpr
    }),
    colon: createToken(":", {
      beforeExpr
    }),
    doubleColon: createToken("::", {
      beforeExpr
    }),
    dot: createToken("."),
    question: createToken("?", {
      beforeExpr
    }),
    questionDot: createToken("?."),
    arrow: createToken("=>", {
      beforeExpr
    }),
    template: createToken("template"),
    ellipsis: createToken("...", {
      beforeExpr
    }),
    backQuote: createToken("`", {
      startsExpr
    }),
    dollarBraceL: createToken("${", {
      beforeExpr,
      startsExpr
    }),
    templateTail: createToken("...`", {
      startsExpr
    }),
    templateNonTail: createToken("...${", {
      beforeExpr,
      startsExpr
    }),
    at: createToken("@"),
    hash: createToken("#", {
      startsExpr
    }),
    interpreterDirective: createToken("#!..."),
    eq: createToken("=", {
      beforeExpr,
      isAssign
    }),
    assign: createToken("_=", {
      beforeExpr,
      isAssign
    }),
    slashAssign: createToken("_=", {
      beforeExpr,
      isAssign
    }),
    xorAssign: createToken("_=", {
      beforeExpr,
      isAssign
    }),
    moduloAssign: createToken("_=", {
      beforeExpr,
      isAssign
    }),
    incDec: createToken("++/--", {
      prefix,
      postfix,
      startsExpr
    }),
    bang: createToken("!", {
      beforeExpr,
      prefix,
      startsExpr
    }),
    tilde: createToken("~", {
      beforeExpr,
      prefix,
      startsExpr
    }),
    doubleCaret: createToken("^^", {
      startsExpr
    }),
    doubleAt: createToken("@@", {
      startsExpr
    }),
    pipeline: createBinop("|>", 0),
    nullishCoalescing: createBinop("??", 1),
    logicalOR: createBinop("||", 1),
    logicalAND: createBinop("&&", 2),
    bitwiseOR: createBinop("|", 3),
    bitwiseXOR: createBinop("^", 4),
    bitwiseAND: createBinop("&", 5),
    equality: createBinop("==/!=/===/!==", 6),
    lt: createBinop("</>/<=/>=", 7),
    gt: createBinop("</>/<=/>=", 7),
    relational: createBinop("</>/<=/>=", 7),
    bitShift: createBinop("<</>>/>>>", 8),
    bitShiftL: createBinop("<</>>/>>>", 8),
    bitShiftR: createBinop("<</>>/>>>", 8),
    plusMin: createToken("+/-", {
      beforeExpr,
      binop: 9,
      prefix,
      startsExpr
    }),
    modulo: createToken("%", {
      binop: 10,
      startsExpr
    }),
    star: createToken("*", {
      binop: 10
    }),
    slash: createBinop("/", 10),
    exponent: createToken("**", {
      beforeExpr,
      binop: 11,
      rightAssociative: true
    }),
    _in: createKeyword("in", {
      beforeExpr,
      binop: 7
    }),
    _instanceof: createKeyword("instanceof", {
      beforeExpr,
      binop: 7
    }),
    _break: createKeyword("break"),
    _case: createKeyword("case", {
      beforeExpr
    }),
    _catch: createKeyword("catch"),
    _continue: createKeyword("continue"),
    _debugger: createKeyword("debugger"),
    _default: createKeyword("default", {
      beforeExpr
    }),
    _else: createKeyword("else", {
      beforeExpr
    }),
    _finally: createKeyword("finally"),
    _function: createKeyword("function", {
      startsExpr
    }),
    _if: createKeyword("if"),
    _return: createKeyword("return", {
      beforeExpr
    }),
    _switch: createKeyword("switch"),
    _throw: createKeyword("throw", {
      beforeExpr,
      prefix,
      startsExpr
    }),
    _try: createKeyword("try"),
    _var: createKeyword("var"),
    _const: createKeyword("const"),
    _with: createKeyword("with"),
    _new: createKeyword("new", {
      beforeExpr,
      startsExpr
    }),
    _this: createKeyword("this", {
      startsExpr
    }),
    _super: createKeyword("super", {
      startsExpr
    }),
    _class: createKeyword("class", {
      startsExpr
    }),
    _extends: createKeyword("extends", {
      beforeExpr
    }),
    _export: createKeyword("export"),
    _import: createKeyword("import", {
      startsExpr
    }),
    _null: createKeyword("null", {
      startsExpr
    }),
    _true: createKeyword("true", {
      startsExpr
    }),
    _false: createKeyword("false", {
      startsExpr
    }),
    _typeof: createKeyword("typeof", {
      beforeExpr,
      prefix,
      startsExpr
    }),
    _void: createKeyword("void", {
      beforeExpr,
      prefix,
      startsExpr
    }),
    _delete: createKeyword("delete", {
      beforeExpr,
      prefix,
      startsExpr
    }),
    _do: createKeyword("do", {
      isLoop,
      beforeExpr
    }),
    _for: createKeyword("for", {
      isLoop
    }),
    _while: createKeyword("while", {
      isLoop
    }),
    _as: createKeywordLike("as", {
      startsExpr
    }),
    _assert: createKeywordLike("assert", {
      startsExpr
    }),
    _async: createKeywordLike("async", {
      startsExpr
    }),
    _await: createKeywordLike("await", {
      startsExpr
    }),
    _defer: createKeywordLike("defer", {
      startsExpr
    }),
    _from: createKeywordLike("from", {
      startsExpr
    }),
    _get: createKeywordLike("get", {
      startsExpr
    }),
    _let: createKeywordLike("let", {
      startsExpr
    }),
    _meta: createKeywordLike("meta", {
      startsExpr
    }),
    _of: createKeywordLike("of", {
      startsExpr
    }),
    _sent: createKeywordLike("sent", {
      startsExpr
    }),
    _set: createKeywordLike("set", {
      startsExpr
    }),
    _source: createKeywordLike("source", {
      startsExpr
    }),
    _static: createKeywordLike("static", {
      startsExpr
    }),
    _using: createKeywordLike("using", {
      startsExpr
    }),
    _yield: createKeywordLike("yield", {
      startsExpr
    }),
    _asserts: createKeywordLike("asserts", {
      startsExpr
    }),
    _checks: createKeywordLike("checks", {
      startsExpr
    }),
    _exports: createKeywordLike("exports", {
      startsExpr
    }),
    _global: createKeywordLike("global", {
      startsExpr
    }),
    _implements: createKeywordLike("implements", {
      startsExpr
    }),
    _intrinsic: createKeywordLike("intrinsic", {
      startsExpr
    }),
    _infer: createKeywordLike("infer", {
      startsExpr
    }),
    _is: createKeywordLike("is", {
      startsExpr
    }),
    _mixins: createKeywordLike("mixins", {
      startsExpr
    }),
    _proto: createKeywordLike("proto", {
      startsExpr
    }),
    _require: createKeywordLike("require", {
      startsExpr
    }),
    _satisfies: createKeywordLike("satisfies", {
      startsExpr
    }),
    _keyof: createKeywordLike("keyof", {
      startsExpr
    }),
    _readonly: createKeywordLike("readonly", {
      startsExpr
    }),
    _unique: createKeywordLike("unique", {
      startsExpr
    }),
    _abstract: createKeywordLike("abstract", {
      startsExpr
    }),
    _declare: createKeywordLike("declare", {
      startsExpr
    }),
    _enum: createKeywordLike("enum", {
      startsExpr
    }),
    _module: createKeywordLike("module", {
      startsExpr
    }),
    _namespace: createKeywordLike("namespace", {
      startsExpr
    }),
    _interface: createKeywordLike("interface", {
      startsExpr
    }),
    _type: createKeywordLike("type", {
      startsExpr
    }),
    _opaque: createKeywordLike("opaque", {
      startsExpr
    }),
    name: createToken("name", {
      startsExpr
    }),
    placeholder: createToken("%%", {
      startsExpr
    }),
    string: createToken("string", {
      startsExpr
    }),
    num: createToken("num", {
      startsExpr
    }),
    bigint: createToken("bigint", {
      startsExpr
    }),
    decimal: createToken("decimal", {
      startsExpr
    }),
    regexp: createToken("regexp", {
      startsExpr
    }),
    privateName: createToken("#name", {
      startsExpr
    }),
    eof: createToken("eof"),
    jsxName: createToken("jsxName"),
    jsxText: createToken("jsxText", {
      beforeExpr
    }),
    jsxTagStart: createToken("jsxTagStart", {
      startsExpr
    }),
    jsxTagEnd: createToken("jsxTagEnd")
  };
  function tokenIsIdentifier(token) {
    return token >= 93 && token <= 133;
  }
  function tokenKeywordOrIdentifierIsKeyword(token) {
    return token <= 92;
  }
  function tokenIsKeywordOrIdentifier(token) {
    return token >= 58 && token <= 133;
  }
  function tokenIsLiteralPropertyName(token) {
    return token >= 58 && token <= 137;
  }
  function tokenComesBeforeExpression(token) {
    return tokenBeforeExprs[token];
  }
  function tokenCanStartExpression(token) {
    return tokenStartsExprs[token];
  }
  function tokenIsAssignment(token) {
    return token >= 29 && token <= 33;
  }
  function tokenIsFlowInterfaceOrTypeOrOpaque(token) {
    return token >= 129 && token <= 131;
  }
  function tokenIsLoop(token) {
    return token >= 90 && token <= 92;
  }
  function tokenIsKeyword(token) {
    return token >= 58 && token <= 92;
  }
  function tokenIsOperator(token) {
    return token >= 39 && token <= 59;
  }
  function tokenIsPostfix(token) {
    return token === 34;
  }
  function tokenIsPrefix(token) {
    return tokenPrefixes[token];
  }
  function tokenIsTSTypeOperator(token) {
    return token >= 121 && token <= 123;
  }
  function tokenIsTSDeclarationStart(token) {
    return token >= 124 && token <= 130;
  }
  function tokenLabelName(token) {
    return tokenLabels[token];
  }
  function tokenOperatorPrecedence(token) {
    return tokenBinops[token];
  }
  function tokenIsRightAssociative(token) {
    return token === 57;
  }
  function tokenIsTemplate(token) {
    return token >= 24 && token <= 25;
  }
  function getExportedToken(token) {
    return tokenTypes[token];
  }
  tokenTypes[8].updateContext = (context) => {
    context.pop();
  };
  tokenTypes[5].updateContext = tokenTypes[7].updateContext = tokenTypes[23].updateContext = (context) => {
    context.push(types.brace);
  };
  tokenTypes[22].updateContext = (context) => {
    if (context[context.length - 1] === types.template) {
      context.pop();
    } else {
      context.push(types.template);
    }
  };
  tokenTypes[143].updateContext = (context) => {
    context.push(types.j_expr, types.j_oTag);
  };
  var nonASCIIidentifierStartChars = "\xAA\xB5\xBA\xC0-\xD6\xD8-\xF6\xF8-\u02C1\u02C6-\u02D1\u02E0-\u02E4\u02EC\u02EE\u0370-\u0374\u0376\u0377\u037A-\u037D\u037F\u0386\u0388-\u038A\u038C\u038E-\u03A1\u03A3-\u03F5\u03F7-\u0481\u048A-\u052F\u0531-\u0556\u0559\u0560-\u0588\u05D0-\u05EA\u05EF-\u05F2\u0620-\u064A\u066E\u066F\u0671-\u06D3\u06D5\u06E5\u06E6\u06EE\u06EF\u06FA-\u06FC\u06FF\u0710\u0712-\u072F\u074D-\u07A5\u07B1\u07CA-\u07EA\u07F4\u07F5\u07FA\u0800-\u0815\u081A\u0824\u0828\u0840-\u0858\u0860-\u086A\u0870-\u0887\u0889-\u088F\u08A0-\u08C9\u0904-\u0939\u093D\u0950\u0958-\u0961\u0971-\u0980\u0985-\u098C\u098F\u0990\u0993-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09BD\u09CE\u09DC\u09DD\u09DF-\u09E1\u09F0\u09F1\u09FC\u0A05-\u0A0A\u0A0F\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32\u0A33\u0A35\u0A36\u0A38\u0A39\u0A59-\u0A5C\u0A5E\u0A72-\u0A74\u0A85-\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0ABD\u0AD0\u0AE0\u0AE1\u0AF9\u0B05-\u0B0C\u0B0F\u0B10\u0B13-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B3D\u0B5C\u0B5D\u0B5F-\u0B61\u0B71\u0B83\u0B85-\u0B8A\u0B8E-\u0B90\u0B92-\u0B95\u0B99\u0B9A\u0B9C\u0B9E\u0B9F\u0BA3\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB9\u0BD0\u0C05-\u0C0C\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C39\u0C3D\u0C58-\u0C5A\u0C5C\u0C5D\u0C60\u0C61\u0C80\u0C85-\u0C8C\u0C8E-\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CBD\u0CDC-\u0CDE\u0CE0\u0CE1\u0CF1\u0CF2\u0D04-\u0D0C\u0D0E-\u0D10\u0D12-\u0D3A\u0D3D\u0D4E\u0D54-\u0D56\u0D5F-\u0D61\u0D7A-\u0D7F\u0D85-\u0D96\u0D9A-\u0DB1\u0DB3-\u0DBB\u0DBD\u0DC0-\u0DC6\u0E01-\u0E30\u0E32\u0E33\u0E40-\u0E46\u0E81\u0E82\u0E84\u0E86-\u0E8A\u0E8C-\u0EA3\u0EA5\u0EA7-\u0EB0\u0EB2\u0EB3\u0EBD\u0EC0-\u0EC4\u0EC6\u0EDC-\u0EDF\u0F00\u0F40-\u0F47\u0F49-\u0F6C\u0F88-\u0F8C\u1000-\u102A\u103F\u1050-\u1055\u105A-\u105D\u1061\u1065\u1066\u106E-\u1070\u1075-\u1081\u108E\u10A0-\u10C5\u10C7\u10CD\u10D0-\u10FA\u10FC-\u1248\u124A-\u124D\u1250-\u1256\u1258\u125A-\u125D\u1260-\u1288\u128A-\u128D\u1290-\u12B0\u12B2-\u12B5\u12B8-\u12BE\u12C0\u12C2-\u12C5\u12C8-\u12D6\u12D8-\u1310\u1312-\u1315\u1318-\u135A\u1380-\u138F\u13A0-\u13F5\u13F8-\u13FD\u1401-\u166C\u166F-\u167F\u1681-\u169A\u16A0-\u16EA\u16EE-\u16F8\u1700-\u1711\u171F-\u1731\u1740-\u1751\u1760-\u176C\u176E-\u1770\u1780-\u17B3\u17D7\u17DC\u1820-\u1878\u1880-\u18A8\u18AA\u18B0-\u18F5\u1900-\u191E\u1950-\u196D\u1970-\u1974\u1980-\u19AB\u19B0-\u19C9\u1A00-\u1A16\u1A20-\u1A54\u1AA7\u1B05-\u1B33\u1B45-\u1B4C\u1B83-\u1BA0\u1BAE\u1BAF\u1BBA-\u1BE5\u1C00-\u1C23\u1C4D-\u1C4F\u1C5A-\u1C7D\u1C80-\u1C8A\u1C90-\u1CBA\u1CBD-\u1CBF\u1CE9-\u1CEC\u1CEE-\u1CF3\u1CF5\u1CF6\u1CFA\u1D00-\u1DBF\u1E00-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6-\u1FCC\u1FD0-\u1FD3\u1FD6-\u1FDB\u1FE0-\u1FEC\u1FF2-\u1FF4\u1FF6-\u1FFC\u2071\u207F\u2090-\u209C\u2102\u2107\u210A-\u2113\u2115\u2118-\u211D\u2124\u2126\u2128\u212A-\u2139\u213C-\u213F\u2145-\u2149\u214E\u2160-\u2188\u2C00-\u2CE4\u2CEB-\u2CEE\u2CF2\u2CF3\u2D00-\u2D25\u2D27\u2D2D\u2D30-\u2D67\u2D6F\u2D80-\u2D96\u2DA0-\u2DA6\u2DA8-\u2DAE\u2DB0-\u2DB6\u2DB8-\u2DBE\u2DC0-\u2DC6\u2DC8-\u2DCE\u2DD0-\u2DD6\u2DD8-\u2DDE\u3005-\u3007\u3021-\u3029\u3031-\u3035\u3038-\u303C\u3041-\u3096\u309B-\u309F\u30A1-\u30FA\u30FC-\u30FF\u3105-\u312F\u3131-\u318E\u31A0-\u31BF\u31F0-\u31FF\u3400-\u4DBF\u4E00-\uA48C\uA4D0-\uA4FD\uA500-\uA60C\uA610-\uA61F\uA62A\uA62B\uA640-\uA66E\uA67F-\uA69D\uA6A0-\uA6EF\uA717-\uA71F\uA722-\uA788\uA78B-\uA7DC\uA7F1-\uA801\uA803-\uA805\uA807-\uA80A\uA80C-\uA822\uA840-\uA873\uA882-\uA8B3\uA8F2-\uA8F7\uA8FB\uA8FD\uA8FE\uA90A-\uA925\uA930-\uA946\uA960-\uA97C\uA984-\uA9B2\uA9CF\uA9E0-\uA9E4\uA9E6-\uA9EF\uA9FA-\uA9FE\uAA00-\uAA28\uAA40-\uAA42\uAA44-\uAA4B\uAA60-\uAA76\uAA7A\uAA7E-\uAAAF\uAAB1\uAAB5\uAAB6\uAAB9-\uAABD\uAAC0\uAAC2\uAADB-\uAADD\uAAE0-\uAAEA\uAAF2-\uAAF4\uAB01-\uAB06\uAB09-\uAB0E\uAB11-\uAB16\uAB20-\uAB26\uAB28-\uAB2E\uAB30-\uAB5A\uAB5C-\uAB69\uAB70-\uABE2\uAC00-\uD7A3\uD7B0-\uD7C6\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFB00-\uFB06\uFB13-\uFB17\uFB1D\uFB1F-\uFB28\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFBB1\uFBD3-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFB\uFE70-\uFE74\uFE76-\uFEFC\uFF21-\uFF3A\uFF41-\uFF5A\uFF66-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF\uFFD2-\uFFD7\uFFDA-\uFFDC";
  var nonASCIIidentifierChars = "\xB7\u0300-\u036F\u0387\u0483-\u0487\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7\u0610-\u061A\u064B-\u0669\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED\u06F0-\u06F9\u0711\u0730-\u074A\u07A6-\u07B0\u07C0-\u07C9\u07EB-\u07F3\u07FD\u0816-\u0819\u081B-\u0823\u0825-\u0827\u0829-\u082D\u0859-\u085B\u0897-\u089F\u08CA-\u08E1\u08E3-\u0903\u093A-\u093C\u093E-\u094F\u0951-\u0957\u0962\u0963\u0966-\u096F\u0981-\u0983\u09BC\u09BE-\u09C4\u09C7\u09C8\u09CB-\u09CD\u09D7\u09E2\u09E3\u09E6-\u09EF\u09FE\u0A01-\u0A03\u0A3C\u0A3E-\u0A42\u0A47\u0A48\u0A4B-\u0A4D\u0A51\u0A66-\u0A71\u0A75\u0A81-\u0A83\u0ABC\u0ABE-\u0AC5\u0AC7-\u0AC9\u0ACB-\u0ACD\u0AE2\u0AE3\u0AE6-\u0AEF\u0AFA-\u0AFF\u0B01-\u0B03\u0B3C\u0B3E-\u0B44\u0B47\u0B48\u0B4B-\u0B4D\u0B55-\u0B57\u0B62\u0B63\u0B66-\u0B6F\u0B82\u0BBE-\u0BC2\u0BC6-\u0BC8\u0BCA-\u0BCD\u0BD7\u0BE6-\u0BEF\u0C00-\u0C04\u0C3C\u0C3E-\u0C44\u0C46-\u0C48\u0C4A-\u0C4D\u0C55\u0C56\u0C62\u0C63\u0C66-\u0C6F\u0C81-\u0C83\u0CBC\u0CBE-\u0CC4\u0CC6-\u0CC8\u0CCA-\u0CCD\u0CD5\u0CD6\u0CE2\u0CE3\u0CE6-\u0CEF\u0CF3\u0D00-\u0D03\u0D3B\u0D3C\u0D3E-\u0D44\u0D46-\u0D48\u0D4A-\u0D4D\u0D57\u0D62\u0D63\u0D66-\u0D6F\u0D81-\u0D83\u0DCA\u0DCF-\u0DD4\u0DD6\u0DD8-\u0DDF\u0DE6-\u0DEF\u0DF2\u0DF3\u0E31\u0E34-\u0E3A\u0E47-\u0E4E\u0E50-\u0E59\u0EB1\u0EB4-\u0EBC\u0EC8-\u0ECE\u0ED0-\u0ED9\u0F18\u0F19\u0F20-\u0F29\u0F35\u0F37\u0F39\u0F3E\u0F3F\u0F71-\u0F84\u0F86\u0F87\u0F8D-\u0F97\u0F99-\u0FBC\u0FC6\u102B-\u103E\u1040-\u1049\u1056-\u1059\u105E-\u1060\u1062-\u1064\u1067-\u106D\u1071-\u1074\u1082-\u108D\u108F-\u109D\u135D-\u135F\u1369-\u1371\u1712-\u1715\u1732-\u1734\u1752\u1753\u1772\u1773\u17B4-\u17D3\u17DD\u17E0-\u17E9\u180B-\u180D\u180F-\u1819\u18A9\u1920-\u192B\u1930-\u193B\u1946-\u194F\u19D0-\u19DA\u1A17-\u1A1B\u1A55-\u1A5E\u1A60-\u1A7C\u1A7F-\u1A89\u1A90-\u1A99\u1AB0-\u1ABD\u1ABF-\u1ADD\u1AE0-\u1AEB\u1B00-\u1B04\u1B34-\u1B44\u1B50-\u1B59\u1B6B-\u1B73\u1B80-\u1B82\u1BA1-\u1BAD\u1BB0-\u1BB9\u1BE6-\u1BF3\u1C24-\u1C37\u1C40-\u1C49\u1C50-\u1C59\u1CD0-\u1CD2\u1CD4-\u1CE8\u1CED\u1CF4\u1CF7-\u1CF9\u1DC0-\u1DFF\u200C\u200D\u203F\u2040\u2054\u20D0-\u20DC\u20E1\u20E5-\u20F0\u2CEF-\u2CF1\u2D7F\u2DE0-\u2DFF\u302A-\u302F\u3099\u309A\u30FB\uA620-\uA629\uA66F\uA674-\uA67D\uA69E\uA69F\uA6F0\uA6F1\uA802\uA806\uA80B\uA823-\uA827\uA82C\uA880\uA881\uA8B4-\uA8C5\uA8D0-\uA8D9\uA8E0-\uA8F1\uA8FF-\uA909\uA926-\uA92D\uA947-\uA953\uA980-\uA983\uA9B3-\uA9C0\uA9D0-\uA9D9\uA9E5\uA9F0-\uA9F9\uAA29-\uAA36\uAA43\uAA4C\uAA4D\uAA50-\uAA59\uAA7B-\uAA7D\uAAB0\uAAB2-\uAAB4\uAAB7\uAAB8\uAABE\uAABF\uAAC1\uAAEB-\uAAEF\uAAF5\uAAF6\uABE3-\uABEA\uABEC\uABED\uABF0-\uABF9\uFB1E\uFE00-\uFE0F\uFE20-\uFE2F\uFE33\uFE34\uFE4D-\uFE4F\uFF10-\uFF19\uFF3F\uFF65";
  var nonASCIIidentifierStart = new RegExp("[" + nonASCIIidentifierStartChars + "]");
  var nonASCIIidentifier = new RegExp("[" + nonASCIIidentifierStartChars + nonASCIIidentifierChars + "]");
  nonASCIIidentifierStartChars = nonASCIIidentifierChars = null;
  var astralIdentifierStartCodes = [0, 11, 2, 25, 2, 18, 2, 1, 2, 14, 3, 13, 35, 122, 70, 52, 268, 28, 4, 48, 48, 31, 14, 29, 6, 37, 11, 29, 3, 35, 5, 7, 2, 4, 43, 157, 19, 35, 5, 35, 5, 39, 9, 51, 13, 10, 2, 14, 2, 6, 2, 1, 2, 10, 2, 14, 2, 6, 2, 1, 4, 51, 13, 310, 10, 21, 11, 7, 25, 5, 2, 41, 2, 8, 70, 5, 3, 0, 2, 43, 2, 1, 4, 0, 3, 22, 11, 22, 10, 30, 66, 18, 2, 1, 11, 21, 11, 25, 7, 25, 39, 55, 7, 1, 65, 0, 16, 3, 2, 2, 2, 28, 43, 28, 4, 28, 36, 7, 2, 27, 28, 53, 11, 21, 11, 18, 14, 17, 111, 72, 56, 50, 14, 50, 14, 35, 39, 27, 10, 22, 251, 41, 7, 1, 17, 5, 57, 28, 11, 0, 9, 21, 43, 17, 47, 20, 28, 22, 13, 52, 58, 1, 3, 0, 14, 44, 33, 24, 27, 35, 30, 0, 3, 0, 9, 34, 4, 0, 13, 47, 15, 3, 22, 0, 2, 0, 36, 17, 2, 24, 20, 1, 64, 6, 2, 0, 2, 3, 2, 14, 2, 9, 8, 46, 39, 7, 3, 1, 3, 21, 2, 6, 2, 1, 2, 4, 4, 0, 19, 0, 13, 4, 31, 9, 2, 0, 3, 0, 2, 37, 2, 0, 26, 0, 2, 0, 45, 52, 19, 3, 21, 2, 31, 47, 21, 1, 2, 0, 185, 46, 42, 3, 37, 47, 21, 0, 60, 42, 14, 0, 72, 26, 38, 6, 186, 43, 117, 63, 32, 7, 3, 0, 3, 7, 2, 1, 2, 23, 16, 0, 2, 0, 95, 7, 3, 38, 17, 0, 2, 0, 29, 0, 11, 39, 8, 0, 22, 0, 12, 45, 20, 0, 19, 72, 200, 32, 32, 8, 2, 36, 18, 0, 50, 29, 113, 6, 2, 1, 2, 37, 22, 0, 26, 5, 2, 1, 2, 31, 15, 0, 24, 43, 261, 18, 16, 0, 2, 12, 2, 33, 125, 0, 80, 921, 103, 110, 18, 195, 2637, 96, 16, 1071, 18, 5, 26, 3994, 6, 582, 6842, 29, 1763, 568, 8, 30, 18, 78, 18, 29, 19, 47, 17, 3, 32, 20, 6, 18, 433, 44, 212, 63, 33, 24, 3, 24, 45, 74, 6, 0, 67, 12, 65, 1, 2, 0, 15, 4, 10, 7381, 42, 31, 98, 114, 8702, 3, 2, 6, 2, 1, 2, 290, 16, 0, 30, 2, 3, 0, 15, 3, 9, 395, 2309, 106, 6, 12, 4, 8, 8, 9, 5991, 84, 2, 70, 2, 1, 3, 0, 3, 1, 3, 3, 2, 11, 2, 0, 2, 6, 2, 64, 2, 3, 3, 7, 2, 6, 2, 27, 2, 3, 2, 4, 2, 0, 4, 6, 2, 339, 3, 24, 2, 24, 2, 30, 2, 24, 2, 30, 2, 24, 2, 30, 2, 24, 2, 30, 2, 24, 2, 7, 1845, 30, 7, 5, 262, 61, 147, 44, 11, 6, 17, 0, 322, 29, 19, 43, 485, 27, 229, 29, 3, 0, 208, 30, 2, 2, 2, 1, 2, 6, 3, 4, 10, 1, 225, 6, 2, 3, 2, 1, 2, 14, 2, 196, 60, 67, 8, 0, 1205, 3, 2, 26, 2, 1, 2, 0, 3, 0, 2, 9, 2, 3, 2, 0, 2, 0, 7, 0, 5, 0, 2, 0, 2, 0, 2, 2, 2, 1, 2, 0, 3, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 1, 2, 0, 3, 3, 2, 6, 2, 3, 2, 3, 2, 0, 2, 9, 2, 16, 6, 2, 2, 4, 2, 16, 4421, 42719, 33, 4381, 3, 5773, 3, 7472, 16, 621, 2467, 541, 1507, 4938, 6, 8489];
  var astralIdentifierCodes = [509, 0, 227, 0, 150, 4, 294, 9, 1368, 2, 2, 1, 6, 3, 41, 2, 5, 0, 166, 1, 574, 3, 9, 9, 7, 9, 32, 4, 318, 1, 78, 5, 71, 10, 50, 3, 123, 2, 54, 14, 32, 10, 3, 1, 11, 3, 46, 10, 8, 0, 46, 9, 7, 2, 37, 13, 2, 9, 6, 1, 45, 0, 13, 2, 49, 13, 9, 3, 2, 11, 83, 11, 7, 0, 3, 0, 158, 11, 6, 9, 7, 3, 56, 1, 2, 6, 3, 1, 3, 2, 10, 0, 11, 1, 3, 6, 4, 4, 68, 8, 2, 0, 3, 0, 2, 3, 2, 4, 2, 0, 15, 1, 83, 17, 10, 9, 5, 0, 82, 19, 13, 9, 214, 6, 3, 8, 28, 1, 83, 16, 16, 9, 82, 12, 9, 9, 7, 19, 58, 14, 5, 9, 243, 14, 166, 9, 71, 5, 2, 1, 3, 3, 2, 0, 2, 1, 13, 9, 120, 6, 3, 6, 4, 0, 29, 9, 41, 6, 2, 3, 9, 0, 10, 10, 47, 15, 199, 7, 137, 9, 54, 7, 2, 7, 17, 9, 57, 21, 2, 13, 123, 5, 4, 0, 2, 1, 2, 6, 2, 0, 9, 9, 49, 4, 2, 1, 2, 4, 9, 9, 55, 9, 266, 3, 10, 1, 2, 0, 49, 6, 4, 4, 14, 10, 5350, 0, 7, 14, 11465, 27, 2343, 9, 87, 9, 39, 4, 60, 6, 26, 9, 535, 9, 470, 0, 2, 54, 8, 3, 82, 0, 12, 1, 19628, 1, 4178, 9, 519, 45, 3, 22, 543, 4, 4, 5, 9, 7, 3, 6, 31, 3, 149, 2, 1418, 49, 513, 54, 5, 49, 9, 0, 15, 0, 23, 4, 2, 14, 1361, 6, 2, 16, 3, 6, 2, 1, 2, 4, 101, 0, 161, 6, 10, 9, 357, 0, 62, 13, 499, 13, 245, 1, 2, 9, 233, 0, 3, 0, 8, 1, 6, 0, 475, 6, 110, 6, 6, 9, 4759, 9, 787719, 239];
  function isInAstralSet(code2, set) {
    let pos = 65536;
    for (let i = 0, length = set.length;i < length; i += 2) {
      pos += set[i];
      if (pos > code2)
        return false;
      pos += set[i + 1];
      if (pos >= code2)
        return true;
    }
    return false;
  }
  function isIdentifierStart(code2) {
    if (code2 < 65)
      return code2 === 36;
    if (code2 <= 90)
      return true;
    if (code2 < 97)
      return code2 === 95;
    if (code2 <= 122)
      return true;
    if (code2 <= 65535) {
      return code2 >= 170 && nonASCIIidentifierStart.test(String.fromCharCode(code2));
    }
    return isInAstralSet(code2, astralIdentifierStartCodes);
  }
  function isIdentifierChar(code2) {
    if (code2 < 48)
      return code2 === 36;
    if (code2 < 58)
      return true;
    if (code2 < 65)
      return false;
    if (code2 <= 90)
      return true;
    if (code2 < 97)
      return code2 === 95;
    if (code2 <= 122)
      return true;
    if (code2 <= 65535) {
      return code2 >= 170 && nonASCIIidentifier.test(String.fromCharCode(code2));
    }
    return isInAstralSet(code2, astralIdentifierStartCodes) || isInAstralSet(code2, astralIdentifierCodes);
  }
  var reservedWords = {
    keyword: ["break", "case", "catch", "continue", "debugger", "default", "do", "else", "finally", "for", "function", "if", "return", "switch", "throw", "try", "var", "const", "while", "with", "new", "this", "super", "class", "extends", "export", "import", "null", "true", "false", "in", "instanceof", "typeof", "void", "delete"],
    strict: ["implements", "interface", "let", "package", "private", "protected", "public", "static", "yield"],
    strictBind: ["eval", "arguments"]
  };
  var keywords = new Set(reservedWords.keyword);
  var reservedWordsStrictSet = new Set(reservedWords.strict);
  var reservedWordsStrictBindSet = new Set(reservedWords.strictBind);
  function isReservedWord(word, inModule) {
    return inModule && word === "await" || word === "enum";
  }
  function isStrictReservedWord(word, inModule) {
    return isReservedWord(word, inModule) || reservedWordsStrictSet.has(word);
  }
  function isStrictBindOnlyReservedWord(word) {
    return reservedWordsStrictBindSet.has(word);
  }
  function isStrictBindReservedWord(word, inModule) {
    return isStrictReservedWord(word, inModule) || isStrictBindOnlyReservedWord(word);
  }
  function isKeyword(word) {
    return keywords.has(word);
  }
  function isIteratorStart(current, next, next2) {
    return current === 64 && next === 64 && isIdentifierStart(next2);
  }
  var reservedWordLikeSet = new Set(["break", "case", "catch", "continue", "debugger", "default", "do", "else", "finally", "for", "function", "if", "return", "switch", "throw", "try", "var", "const", "while", "with", "new", "this", "super", "class", "extends", "export", "import", "null", "true", "false", "in", "instanceof", "typeof", "void", "delete", "implements", "interface", "let", "package", "private", "protected", "public", "static", "yield", "eval", "arguments", "enum", "await"]);
  function canBeReservedWord(word) {
    return reservedWordLikeSet.has(word);
  }

  class Scope {
    constructor(flags) {
      this.flags = 0;
      this.names = new Map;
      this.firstLexicalName = "";
      this.flags = flags;
    }
  }

  class ScopeHandler {
    constructor(parser, inModule) {
      this.parser = undefined;
      this.scopeStack = [];
      this.inModule = undefined;
      this.undefinedExports = new Map;
      this.parser = parser;
      this.inModule = inModule;
    }
    get inTopLevel() {
      return (this.currentScope().flags & 1) > 0;
    }
    get inFunction() {
      return (this.currentVarScopeFlags() & 2) > 0;
    }
    get allowSuper() {
      return (this.currentThisScopeFlags() & 16) > 0;
    }
    get allowDirectSuper() {
      return (this.currentThisScopeFlags() & 32) > 0;
    }
    get allowNewTarget() {
      return (this.currentThisScopeFlags() & 512) > 0;
    }
    get inClass() {
      return (this.currentThisScopeFlags() & 64) > 0;
    }
    get inClassAndNotInNonArrowFunction() {
      const flags = this.currentThisScopeFlags();
      return (flags & 64) > 0 && (flags & 2) === 0;
    }
    get inStaticBlock() {
      for (let i = this.scopeStack.length - 1;; i--) {
        const {
          flags
        } = this.scopeStack[i];
        if (flags & 128) {
          return true;
        }
        if (flags & (1667 | 64)) {
          return false;
        }
      }
    }
    get inNonArrowFunction() {
      return (this.currentThisScopeFlags() & 2) > 0;
    }
    get inBareCaseStatement() {
      return (this.currentScope().flags & 256) > 0;
    }
    get treatFunctionsAsVar() {
      return this.treatFunctionsAsVarInScope(this.currentScope());
    }
    createScope(flags) {
      return new Scope(flags);
    }
    enter(flags) {
      this.scopeStack.push(this.createScope(flags));
    }
    exit() {
      const scope = this.scopeStack.pop();
      return scope.flags;
    }
    treatFunctionsAsVarInScope(scope) {
      return !!(scope.flags & (2 | 128) || !this.parser.inModule && scope.flags & 1);
    }
    declareName(name, bindingType, loc) {
      let scope = this.currentScope();
      if (bindingType & 8 || bindingType & 16) {
        this.checkRedeclarationInScope(scope, name, bindingType, loc);
        let type = scope.names.get(name) || 0;
        if (bindingType & 16) {
          type = type | 4;
        } else {
          if (!scope.firstLexicalName) {
            scope.firstLexicalName = name;
          }
          type = type | 2;
        }
        scope.names.set(name, type);
        if (bindingType & 8) {
          this.maybeExportDefined(scope, name);
        }
      } else if (bindingType & 4) {
        for (let i = this.scopeStack.length - 1;i >= 0; --i) {
          scope = this.scopeStack[i];
          this.checkRedeclarationInScope(scope, name, bindingType, loc);
          scope.names.set(name, (scope.names.get(name) || 0) | 1);
          this.maybeExportDefined(scope, name);
          if (scope.flags & 1667)
            break;
        }
      }
      if (this.parser.inModule && scope.flags & 1) {
        this.undefinedExports.delete(name);
      }
    }
    maybeExportDefined(scope, name) {
      if (this.parser.inModule && scope.flags & 1) {
        this.undefinedExports.delete(name);
      }
    }
    checkRedeclarationInScope(scope, name, bindingType, loc) {
      if (this.isRedeclaredInScope(scope, name, bindingType)) {
        this.parser.raise(Errors.VarRedeclaration, loc, {
          identifierName: name
        });
      }
    }
    isRedeclaredInScope(scope, name, bindingType) {
      if (!(bindingType & 1))
        return false;
      if (bindingType & 8) {
        return scope.names.has(name);
      }
      const type = scope.names.get(name) || 0;
      if (bindingType & 16) {
        return (type & 2) > 0 || !this.treatFunctionsAsVarInScope(scope) && (type & 1) > 0;
      }
      return (type & 2) > 0 && !(scope.flags & 8 && scope.firstLexicalName === name) || !this.treatFunctionsAsVarInScope(scope) && (type & 4) > 0;
    }
    checkLocalExport(id) {
      const {
        name
      } = id;
      const topLevelScope = this.scopeStack[0];
      if (!topLevelScope.names.has(name)) {
        this.undefinedExports.set(name, id.loc.start);
      }
    }
    currentScope() {
      return this.scopeStack[this.scopeStack.length - 1];
    }
    currentVarScopeFlags() {
      for (let i = this.scopeStack.length - 1;; i--) {
        const {
          flags
        } = this.scopeStack[i];
        if (flags & 1667) {
          return flags;
        }
      }
    }
    currentThisScopeFlags() {
      for (let i = this.scopeStack.length - 1;; i--) {
        const {
          flags
        } = this.scopeStack[i];
        if (flags & (1667 | 64) && !(flags & 4)) {
          return flags;
        }
      }
    }
  }

  class FlowScope extends Scope {
    constructor(...args) {
      super(...args);
      this.declareFunctions = new Set;
    }
  }

  class FlowScopeHandler extends ScopeHandler {
    createScope(flags) {
      return new FlowScope(flags);
    }
    declareName(name, bindingType, loc) {
      const scope = this.currentScope();
      if (bindingType & 2048) {
        this.checkRedeclarationInScope(scope, name, bindingType, loc);
        this.maybeExportDefined(scope, name);
        scope.declareFunctions.add(name);
        return;
      }
      super.declareName(name, bindingType, loc);
    }
    isRedeclaredInScope(scope, name, bindingType) {
      if (super.isRedeclaredInScope(scope, name, bindingType))
        return true;
      if (bindingType & 2048 && !scope.declareFunctions.has(name)) {
        const type = scope.names.get(name);
        return (type & 4) > 0 || (type & 2) > 0;
      }
      return false;
    }
    checkLocalExport(id) {
      if (!this.scopeStack[0].declareFunctions.has(id.name)) {
        super.checkLocalExport(id);
      }
    }
  }
  var reservedTypes = new Set(["_", "any", "bool", "boolean", "empty", "extends", "false", "interface", "mixed", "null", "number", "static", "string", "true", "typeof", "void"]);
  var FlowErrors = ParseErrorEnum`flow`({
    AmbiguousConditionalArrow: "Ambiguous expression: wrap the arrow functions in parentheses to disambiguate.",
    AmbiguousDeclareModuleKind: "Found both `declare module.exports` and `declare export` in the same module. Modules can only have 1 since they are either an ES module or they are a CommonJS module.",
    AssignReservedType: ({
      reservedType
    }) => `Cannot overwrite reserved type ${reservedType}.`,
    DeclareClassElement: "The `declare` modifier can only appear on class fields.",
    DeclareClassFieldInitializer: "Initializers are not allowed in fields with the `declare` modifier.",
    DuplicateDeclareModuleExports: "Duplicate `declare module.exports` statement.",
    EnumBooleanMemberNotInitialized: ({
      memberName,
      enumName
    }) => `Boolean enum members need to be initialized. Use either \`${memberName} = true,\` or \`${memberName} = false,\` in enum \`${enumName}\`.`,
    EnumDuplicateMemberName: ({
      memberName,
      enumName
    }) => `Enum member names need to be unique, but the name \`${memberName}\` has already been used before in enum \`${enumName}\`.`,
    EnumInconsistentMemberValues: ({
      enumName
    }) => `Enum \`${enumName}\` has inconsistent member initializers. Either use no initializers, or consistently use literals (either booleans, numbers, or strings) for all member initializers.`,
    EnumInvalidExplicitType: ({
      invalidEnumType,
      enumName
    }) => `Enum type \`${invalidEnumType}\` is not valid. Use one of \`boolean\`, \`number\`, \`string\`, or \`symbol\` in enum \`${enumName}\`.`,
    EnumInvalidExplicitTypeUnknownSupplied: ({
      enumName
    }) => `Supplied enum type is not valid. Use one of \`boolean\`, \`number\`, \`string\`, or \`symbol\` in enum \`${enumName}\`.`,
    EnumInvalidMemberInitializerPrimaryType: ({
      enumName,
      memberName,
      explicitType
    }) => `Enum \`${enumName}\` has type \`${explicitType}\`, so the initializer of \`${memberName}\` needs to be a ${explicitType} literal.`,
    EnumInvalidMemberInitializerSymbolType: ({
      enumName,
      memberName
    }) => `Symbol enum members cannot be initialized. Use \`${memberName},\` in enum \`${enumName}\`.`,
    EnumInvalidMemberInitializerUnknownType: ({
      enumName,
      memberName
    }) => `The enum member initializer for \`${memberName}\` needs to be a literal (either a boolean, number, or string) in enum \`${enumName}\`.`,
    EnumInvalidMemberName: ({
      enumName,
      memberName,
      suggestion
    }) => `Enum member names cannot start with lowercase 'a' through 'z'. Instead of using \`${memberName}\`, consider using \`${suggestion}\`, in enum \`${enumName}\`.`,
    EnumNumberMemberNotInitialized: ({
      enumName,
      memberName
    }) => `Number enum members need to be initialized, e.g. \`${memberName} = 1\` in enum \`${enumName}\`.`,
    EnumStringMemberInconsistentlyInitialized: ({
      enumName
    }) => `String enum members need to consistently either all use initializers, or use no initializers, in enum \`${enumName}\`.`,
    GetterMayNotHaveThisParam: "A getter cannot have a `this` parameter.",
    ImportReflectionHasImportType: "An `import module` declaration can not use `type` or `typeof` keyword.",
    ImportTypeShorthandOnlyInPureImport: "The `type` and `typeof` keywords on named imports can only be used on regular `import` statements. It cannot be used with `import type` or `import typeof` statements.",
    InexactInsideExact: "Explicit inexact syntax cannot appear inside an explicit exact object type.",
    InexactInsideNonObject: "Explicit inexact syntax cannot appear in class or interface definitions.",
    InexactVariance: "Explicit inexact syntax cannot have variance.",
    InvalidNonTypeImportInDeclareModule: "Imports within a `declare module` body must always be `import type` or `import typeof`.",
    MissingTypeParamDefault: "Type parameter declaration needs a default, since a preceding type parameter declaration has a default.",
    NestedDeclareModule: "`declare module` cannot be used inside another `declare module`.",
    NestedFlowComment: "Cannot have a flow comment inside another flow comment.",
    PatternIsOptional: Object.assign({
      message: "A binding pattern parameter cannot be optional in an implementation signature."
    }, {
      reasonCode: "OptionalBindingPattern"
    }),
    SetterMayNotHaveThisParam: "A setter cannot have a `this` parameter.",
    SpreadVariance: "Spread properties cannot have variance.",
    ThisParamAnnotationRequired: "A type annotation is required for the `this` parameter.",
    ThisParamBannedInConstructor: "Constructors cannot have a `this` parameter; constructors don't bind `this` like other functions.",
    ThisParamMayNotBeOptional: "The `this` parameter cannot be optional.",
    ThisParamMustBeFirst: "The `this` parameter must be the first function parameter.",
    ThisParamNoDefault: "The `this` parameter may not have a default value.",
    TypeBeforeInitializer: "Type annotations must come before default assignments, e.g. instead of `age = 25: number` use `age: number = 25`.",
    TypeCastInPattern: "The type cast expression is expected to be wrapped with parenthesis.",
    UnexpectedExplicitInexactInObject: "Explicit inexact syntax must appear at the end of an inexact object.",
    UnexpectedReservedType: ({
      reservedType
    }) => `Unexpected reserved type ${reservedType}.`,
    UnexpectedReservedUnderscore: "`_` is only allowed as a type argument to call or new.",
    UnexpectedSpaceBetweenModuloChecks: "Spaces between `%` and `checks` are not allowed here.",
    UnexpectedSpreadType: "Spread operator cannot appear in class or interface definitions.",
    UnexpectedSubtractionOperand: 'Unexpected token, expected "number" or "bigint".',
    UnexpectedTokenAfterTypeParameter: "Expected an arrow function after this type parameter declaration.",
    UnexpectedTypeParameterBeforeAsyncArrowFunction: "Type parameters must come after the async keyword, e.g. instead of `<T> async () => {}`, use `async <T>() => {}`.",
    UnsupportedDeclareExportKind: ({
      unsupportedExportKind,
      suggestion
    }) => `\`declare export ${unsupportedExportKind}\` is not supported. Use \`${suggestion}\` instead.`,
    UnsupportedStatementInDeclareModule: "Only declares and type imports are allowed inside declare module.",
    UnterminatedFlowComment: "Unterminated flow-comment."
  });
  function isEsModuleType(bodyElement) {
    return bodyElement.type === "DeclareExportAllDeclaration" || bodyElement.type === "DeclareExportDeclaration" && (!bodyElement.declaration || bodyElement.declaration.type !== "TypeAlias" && bodyElement.declaration.type !== "InterfaceDeclaration");
  }
  function hasTypeImportKind(node) {
    return node.importKind === "type" || node.importKind === "typeof";
  }
  var exportSuggestions = {
    const: "declare export var",
    let: "declare export var",
    type: "export type",
    interface: "export interface"
  };
  function partition(list, test) {
    const list1 = [];
    const list2 = [];
    for (let i = 0;i < list.length; i++) {
      (test(list[i], i, list) ? list1 : list2).push(list[i]);
    }
    return [list1, list2];
  }
  var FLOW_PRAGMA_REGEX = /\*?\s*@((?:no)?flow)\b/;
  var flow = (superClass) => class FlowParserMixin extends superClass {
    constructor(...args) {
      super(...args);
      this.flowPragma = undefined;
    }
    getScopeHandler() {
      return FlowScopeHandler;
    }
    shouldParseTypes() {
      return this.getPluginOption("flow", "all") || this.flowPragma === "flow";
    }
    finishToken(type, val) {
      if (type !== 134 && type !== 13 && type !== 28) {
        if (this.flowPragma === undefined) {
          this.flowPragma = null;
        }
      }
      super.finishToken(type, val);
    }
    addComment(comment) {
      if (this.flowPragma === undefined) {
        const matches = FLOW_PRAGMA_REGEX.exec(comment.value);
        if (!matches)
          ;
        else if (matches[1] === "flow") {
          this.flowPragma = "flow";
        } else if (matches[1] === "noflow") {
          this.flowPragma = "noflow";
        } else {
          throw new Error("Unexpected flow pragma");
        }
      }
      super.addComment(comment);
    }
    flowParseTypeInitialiser(tok) {
      const oldInType = this.state.inType;
      this.state.inType = true;
      this.expect(tok || 14);
      const type = this.flowParseType();
      this.state.inType = oldInType;
      return type;
    }
    flowParsePredicate() {
      const node = this.startNode();
      const moduloLoc = this.state.startLoc;
      this.next();
      this.expectContextual(110);
      if (this.state.lastTokStartLoc.index > moduloLoc.index + 1) {
        this.raise(FlowErrors.UnexpectedSpaceBetweenModuloChecks, moduloLoc);
      }
      if (this.eat(10)) {
        node.value = super.parseExpression();
        this.expect(11);
        return this.finishNode(node, "DeclaredPredicate");
      } else {
        return this.finishNode(node, "InferredPredicate");
      }
    }
    flowParseTypeAndPredicateInitialiser() {
      const oldInType = this.state.inType;
      this.state.inType = true;
      this.expect(14);
      let type = null;
      let predicate = null;
      if (this.match(54)) {
        this.state.inType = oldInType;
        predicate = this.flowParsePredicate();
      } else {
        type = this.flowParseType();
        this.state.inType = oldInType;
        if (this.match(54)) {
          predicate = this.flowParsePredicate();
        }
      }
      return [type, predicate];
    }
    flowParseDeclareClass(node) {
      this.next();
      this.flowParseInterfaceish(node, true);
      return this.finishNode(node, "DeclareClass");
    }
    flowParseDeclareFunction(node) {
      this.next();
      const id = node.id = this.parseIdentifier();
      const typeNode = this.startNode();
      const typeContainer = this.startNode();
      if (this.match(47)) {
        typeNode.typeParameters = this.flowParseTypeParameterDeclaration();
      } else {
        typeNode.typeParameters = null;
      }
      this.expect(10);
      const tmp = this.flowParseFunctionTypeParams();
      typeNode.params = tmp.params;
      typeNode.rest = tmp.rest;
      typeNode.this = tmp._this;
      this.expect(11);
      [typeNode.returnType, node.predicate] = this.flowParseTypeAndPredicateInitialiser();
      typeContainer.typeAnnotation = this.finishNode(typeNode, "FunctionTypeAnnotation");
      id.typeAnnotation = this.finishNode(typeContainer, "TypeAnnotation");
      this.resetEndLocation(id);
      this.semicolon();
      this.scope.declareName(node.id.name, 2048, node.id.loc.start);
      return this.finishNode(node, "DeclareFunction");
    }
    flowParseDeclare(node, insideModule) {
      if (this.match(80)) {
        return this.flowParseDeclareClass(node);
      } else if (this.match(68)) {
        return this.flowParseDeclareFunction(node);
      } else if (this.match(74)) {
        return this.flowParseDeclareVariable(node);
      } else if (this.eatContextual(127)) {
        if (this.match(16)) {
          return this.flowParseDeclareModuleExports(node);
        } else {
          if (insideModule) {
            this.raise(FlowErrors.NestedDeclareModule, this.state.lastTokStartLoc);
          }
          return this.flowParseDeclareModule(node);
        }
      } else if (this.isContextual(130)) {
        return this.flowParseDeclareTypeAlias(node);
      } else if (this.isContextual(131)) {
        return this.flowParseDeclareOpaqueType(node);
      } else if (this.isContextual(129)) {
        return this.flowParseDeclareInterface(node);
      } else if (this.match(82)) {
        return this.flowParseDeclareExportDeclaration(node, insideModule);
      }
      throw this.unexpected();
    }
    flowParseDeclareVariable(node) {
      this.next();
      node.id = this.flowParseTypeAnnotatableIdentifier();
      this.scope.declareName(node.id.name, 5, node.id.loc.start);
      this.semicolon();
      return this.finishNode(node, "DeclareVariable");
    }
    flowParseDeclareModule(node) {
      this.scope.enter(0);
      if (this.match(134)) {
        node.id = super.parseExprAtom();
      } else {
        node.id = this.parseIdentifier();
      }
      const bodyNode = node.body = this.startNode();
      const body = bodyNode.body = [];
      this.expect(5);
      while (!this.match(8)) {
        const bodyNode2 = this.startNode();
        if (this.match(83)) {
          this.next();
          if (!this.isContextual(130) && !this.match(87)) {
            this.raise(FlowErrors.InvalidNonTypeImportInDeclareModule, this.state.lastTokStartLoc);
          }
          body.push(super.parseImport(bodyNode2));
        } else {
          this.expectContextual(125, FlowErrors.UnsupportedStatementInDeclareModule);
          body.push(this.flowParseDeclare(bodyNode2, true));
        }
      }
      this.scope.exit();
      this.expect(8);
      this.finishNode(bodyNode, "BlockStatement");
      let kind = null;
      let hasModuleExport = false;
      body.forEach((bodyElement) => {
        if (isEsModuleType(bodyElement)) {
          if (kind === "CommonJS") {
            this.raise(FlowErrors.AmbiguousDeclareModuleKind, bodyElement);
          }
          kind = "ES";
        } else if (bodyElement.type === "DeclareModuleExports") {
          if (hasModuleExport) {
            this.raise(FlowErrors.DuplicateDeclareModuleExports, bodyElement);
          }
          if (kind === "ES") {
            this.raise(FlowErrors.AmbiguousDeclareModuleKind, bodyElement);
          }
          kind = "CommonJS";
          hasModuleExport = true;
        }
      });
      node.kind = kind || "CommonJS";
      return this.finishNode(node, "DeclareModule");
    }
    flowParseDeclareExportDeclaration(node, insideModule) {
      this.expect(82);
      if (this.eat(65)) {
        if (this.match(68) || this.match(80)) {
          node.declaration = this.flowParseDeclare(this.startNode());
        } else {
          node.declaration = this.flowParseType();
          this.semicolon();
        }
        node.default = true;
        return this.finishNode(node, "DeclareExportDeclaration");
      } else {
        if (this.match(75) || this.isLet() || (this.isContextual(130) || this.isContextual(129)) && !insideModule) {
          const label = this.state.value;
          throw this.raise(FlowErrors.UnsupportedDeclareExportKind, this.state.startLoc, {
            unsupportedExportKind: label,
            suggestion: exportSuggestions[label]
          });
        }
        if (this.match(74) || this.match(68) || this.match(80) || this.isContextual(131)) {
          node.declaration = this.flowParseDeclare(this.startNode());
          node.default = false;
          return this.finishNode(node, "DeclareExportDeclaration");
        } else if (this.match(55) || this.match(5) || this.isContextual(129) || this.isContextual(130) || this.isContextual(131)) {
          node = this.parseExport(node, null);
          if (node.type === "ExportNamedDeclaration") {
            node.default = false;
            delete node.exportKind;
            return this.castNodeTo(node, "DeclareExportDeclaration");
          } else {
            return this.castNodeTo(node, "DeclareExportAllDeclaration");
          }
        }
      }
      throw this.unexpected();
    }
    flowParseDeclareModuleExports(node) {
      this.next();
      this.expectContextual(111);
      node.typeAnnotation = this.flowParseTypeAnnotation();
      this.semicolon();
      return this.finishNode(node, "DeclareModuleExports");
    }
    flowParseDeclareTypeAlias(node) {
      this.next();
      const finished = this.flowParseTypeAlias(node);
      this.castNodeTo(finished, "DeclareTypeAlias");
      return finished;
    }
    flowParseDeclareOpaqueType(node) {
      this.next();
      const finished = this.flowParseOpaqueType(node, true);
      this.castNodeTo(finished, "DeclareOpaqueType");
      return finished;
    }
    flowParseDeclareInterface(node) {
      this.next();
      this.flowParseInterfaceish(node, false);
      return this.finishNode(node, "DeclareInterface");
    }
    flowParseInterfaceish(node, isClass) {
      node.id = this.flowParseRestrictedIdentifier(!isClass, true);
      this.scope.declareName(node.id.name, isClass ? 17 : 8201, node.id.loc.start);
      if (this.match(47)) {
        node.typeParameters = this.flowParseTypeParameterDeclaration();
      } else {
        node.typeParameters = null;
      }
      node.extends = [];
      if (this.eat(81)) {
        do {
          node.extends.push(this.flowParseInterfaceExtends());
        } while (!isClass && this.eat(12));
      }
      if (isClass) {
        node.implements = [];
        node.mixins = [];
        if (this.eatContextual(117)) {
          do {
            node.mixins.push(this.flowParseInterfaceExtends());
          } while (this.eat(12));
        }
        if (this.eatContextual(113)) {
          do {
            node.implements.push(this.flowParseInterfaceExtends());
          } while (this.eat(12));
        }
      }
      node.body = this.flowParseObjectType({
        allowStatic: isClass,
        allowExact: false,
        allowSpread: false,
        allowProto: isClass,
        allowInexact: false
      });
    }
    flowParseInterfaceExtends() {
      const node = this.startNode();
      node.id = this.flowParseQualifiedTypeIdentifier();
      if (this.match(47)) {
        node.typeParameters = this.flowParseTypeParameterInstantiation();
      } else {
        node.typeParameters = null;
      }
      return this.finishNode(node, "InterfaceExtends");
    }
    flowParseInterface(node) {
      this.flowParseInterfaceish(node, false);
      return this.finishNode(node, "InterfaceDeclaration");
    }
    checkNotUnderscore(word) {
      if (word === "_") {
        this.raise(FlowErrors.UnexpectedReservedUnderscore, this.state.startLoc);
      }
    }
    checkReservedType(word, startLoc, declaration) {
      if (!reservedTypes.has(word))
        return;
      this.raise(declaration ? FlowErrors.AssignReservedType : FlowErrors.UnexpectedReservedType, startLoc, {
        reservedType: word
      });
    }
    flowParseRestrictedIdentifierName(liberal, declaration) {
      this.checkReservedType(this.state.value, this.state.startLoc, declaration);
      return this.parseIdentifierName(liberal);
    }
    flowParseRestrictedIdentifier(liberal, declaration) {
      const node = this.startNode();
      const name = this.flowParseRestrictedIdentifierName(liberal, declaration);
      return this.createIdentifier(node, name);
    }
    flowParseTypeAlias(node) {
      node.id = this.flowParseRestrictedIdentifier(false, true);
      this.scope.declareName(node.id.name, 8201, node.id.loc.start);
      if (this.match(47)) {
        node.typeParameters = this.flowParseTypeParameterDeclaration();
      } else {
        node.typeParameters = null;
      }
      node.right = this.flowParseTypeInitialiser(29);
      this.semicolon();
      return this.finishNode(node, "TypeAlias");
    }
    flowParseOpaqueType(node, declare) {
      this.expectContextual(130);
      node.id = this.flowParseRestrictedIdentifier(true, true);
      this.scope.declareName(node.id.name, 8201, node.id.loc.start);
      if (this.match(47)) {
        node.typeParameters = this.flowParseTypeParameterDeclaration();
      } else {
        node.typeParameters = null;
      }
      node.supertype = null;
      if (this.match(14)) {
        node.supertype = this.flowParseTypeInitialiser(14);
      }
      node.impltype = null;
      if (!declare) {
        node.impltype = this.flowParseTypeInitialiser(29);
      }
      this.semicolon();
      return this.finishNode(node, "OpaqueType");
    }
    flowParseTypeParameterBound() {
      if (this.match(14) || this.isContextual(81)) {
        const node = this.startNode();
        this.next();
        node.typeAnnotation = this.flowParseType();
        return this.finishNode(node, "TypeAnnotation");
      }
    }
    flowParseTypeParameter(requireDefault = false) {
      const nodeStartLoc = this.state.startLoc;
      const node = this.startNode();
      const variance = this.flowParseVariance();
      node.name = this.flowParseRestrictedIdentifierName();
      node.variance = variance;
      node.bound = this.flowParseTypeParameterBound();
      if (this.match(29)) {
        this.eat(29);
        node.default = this.flowParseType();
      } else {
        if (requireDefault) {
          this.raise(FlowErrors.MissingTypeParamDefault, nodeStartLoc);
        }
      }
      return this.finishNode(node, "TypeParameter");
    }
    flowParseTypeParameterDeclaration() {
      const oldInType = this.state.inType;
      const node = this.startNode();
      node.params = [];
      this.state.inType = true;
      if (this.match(47) || this.match(143)) {
        this.next();
      } else {
        this.unexpected();
      }
      let defaultRequired = false;
      do {
        const typeParameter = this.flowParseTypeParameter(defaultRequired);
        node.params.push(typeParameter);
        if (typeParameter.default) {
          defaultRequired = true;
        }
        if (!this.match(48)) {
          this.expect(12);
        }
      } while (!this.match(48));
      this.expect(48);
      this.state.inType = oldInType;
      return this.finishNode(node, "TypeParameterDeclaration");
    }
    flowInTopLevelContext(cb) {
      if (this.curContext() !== types.brace) {
        const oldContext = this.state.context;
        this.state.context = [oldContext[0]];
        try {
          return cb();
        } finally {
          this.state.context = oldContext;
        }
      } else {
        return cb();
      }
    }
    flowParseTypeParameterInstantiationInExpression() {
      if (this.reScan_lt() !== 47)
        return;
      return this.flowParseTypeParameterInstantiation();
    }
    flowParseTypeParameterInstantiation() {
      const node = this.startNode();
      const oldInType = this.state.inType;
      this.state.inType = true;
      node.params = [];
      this.flowInTopLevelContext(() => {
        this.expect(47);
        const oldNoAnonFunctionType = this.state.noAnonFunctionType;
        this.state.noAnonFunctionType = false;
        while (!this.match(48)) {
          node.params.push(this.flowParseType());
          if (!this.match(48)) {
            this.expect(12);
          }
        }
        this.state.noAnonFunctionType = oldNoAnonFunctionType;
      });
      this.state.inType = oldInType;
      if (!this.state.inType && this.curContext() === types.brace) {
        this.reScan_lt_gt();
      }
      this.expect(48);
      return this.finishNode(node, "TypeParameterInstantiation");
    }
    flowParseTypeParameterInstantiationCallOrNew() {
      if (this.reScan_lt() !== 47)
        return null;
      const node = this.startNode();
      const oldInType = this.state.inType;
      node.params = [];
      this.state.inType = true;
      this.expect(47);
      while (!this.match(48)) {
        node.params.push(this.flowParseTypeOrImplicitInstantiation());
        if (!this.match(48)) {
          this.expect(12);
        }
      }
      this.expect(48);
      this.state.inType = oldInType;
      return this.finishNode(node, "TypeParameterInstantiation");
    }
    flowParseInterfaceType() {
      const node = this.startNode();
      this.expectContextual(129);
      node.extends = [];
      if (this.eat(81)) {
        do {
          node.extends.push(this.flowParseInterfaceExtends());
        } while (this.eat(12));
      }
      node.body = this.flowParseObjectType({
        allowStatic: false,
        allowExact: false,
        allowSpread: false,
        allowProto: false,
        allowInexact: false
      });
      return this.finishNode(node, "InterfaceTypeAnnotation");
    }
    flowParseObjectPropertyKey() {
      return this.match(135) || this.match(134) ? super.parseExprAtom() : this.parseIdentifier(true);
    }
    flowParseObjectTypeIndexer(node, isStatic, variance) {
      node.static = isStatic;
      if (this.lookahead().type === 14) {
        node.id = this.flowParseObjectPropertyKey();
        node.key = this.flowParseTypeInitialiser();
      } else {
        node.id = null;
        node.key = this.flowParseType();
      }
      this.expect(3);
      node.value = this.flowParseTypeInitialiser();
      node.variance = variance;
      return this.finishNode(node, "ObjectTypeIndexer");
    }
    flowParseObjectTypeInternalSlot(node, isStatic) {
      node.static = isStatic;
      node.id = this.flowParseObjectPropertyKey();
      this.expect(3);
      this.expect(3);
      if (this.match(47) || this.match(10)) {
        node.method = true;
        node.optional = false;
        node.value = this.flowParseObjectTypeMethodish(this.startNodeAt(node.loc.start));
      } else {
        node.method = false;
        if (this.eat(17)) {
          node.optional = true;
        }
        node.value = this.flowParseTypeInitialiser();
      }
      return this.finishNode(node, "ObjectTypeInternalSlot");
    }
    flowParseObjectTypeMethodish(node) {
      node.params = [];
      node.rest = null;
      node.typeParameters = null;
      node.this = null;
      if (this.match(47)) {
        node.typeParameters = this.flowParseTypeParameterDeclaration();
      }
      this.expect(10);
      if (this.match(78)) {
        node.this = this.flowParseFunctionTypeParam(true);
        node.this.name = null;
        if (!this.match(11)) {
          this.expect(12);
        }
      }
      while (!this.match(11) && !this.match(21)) {
        node.params.push(this.flowParseFunctionTypeParam(false));
        if (!this.match(11)) {
          this.expect(12);
        }
      }
      if (this.eat(21)) {
        node.rest = this.flowParseFunctionTypeParam(false);
      }
      this.expect(11);
      node.returnType = this.flowParseTypeInitialiser();
      return this.finishNode(node, "FunctionTypeAnnotation");
    }
    flowParseObjectTypeCallProperty(node, isStatic) {
      const valueNode = this.startNode();
      node.static = isStatic;
      node.value = this.flowParseObjectTypeMethodish(valueNode);
      return this.finishNode(node, "ObjectTypeCallProperty");
    }
    flowParseObjectType({
      allowStatic,
      allowExact,
      allowSpread,
      allowProto,
      allowInexact
    }) {
      const oldInType = this.state.inType;
      this.state.inType = true;
      const nodeStart = this.startNode();
      nodeStart.callProperties = [];
      nodeStart.properties = [];
      nodeStart.indexers = [];
      nodeStart.internalSlots = [];
      let endDelim;
      let exact;
      let inexact = false;
      if (allowExact && this.match(6)) {
        this.expect(6);
        endDelim = 9;
        exact = true;
      } else {
        this.expect(5);
        endDelim = 8;
        exact = false;
      }
      nodeStart.exact = exact;
      while (!this.match(endDelim)) {
        let isStatic = false;
        let protoStartLoc = null;
        let inexactStartLoc = null;
        const node = this.startNode();
        if (allowProto && this.isContextual(118)) {
          const lookahead = this.lookahead();
          if (lookahead.type !== 14 && lookahead.type !== 17) {
            this.next();
            protoStartLoc = this.state.startLoc;
            allowStatic = false;
          }
        }
        if (allowStatic && this.isContextual(106)) {
          const lookahead = this.lookahead();
          if (lookahead.type !== 14 && lookahead.type !== 17) {
            this.next();
            isStatic = true;
          }
        }
        const variance = this.flowParseVariance();
        if (this.eat(0)) {
          if (protoStartLoc != null) {
            this.unexpected(protoStartLoc);
          }
          if (this.eat(0)) {
            if (variance) {
              this.unexpected(variance.loc.start);
            }
            nodeStart.internalSlots.push(this.flowParseObjectTypeInternalSlot(node, isStatic));
          } else {
            nodeStart.indexers.push(this.flowParseObjectTypeIndexer(node, isStatic, variance));
          }
        } else if (this.match(10) || this.match(47)) {
          if (protoStartLoc != null) {
            this.unexpected(protoStartLoc);
          }
          if (variance) {
            this.unexpected(variance.loc.start);
          }
          nodeStart.callProperties.push(this.flowParseObjectTypeCallProperty(node, isStatic));
        } else {
          let kind = "init";
          if (this.isContextual(99) || this.isContextual(104)) {
            const lookahead = this.lookahead();
            if (tokenIsLiteralPropertyName(lookahead.type)) {
              kind = this.state.value;
              this.next();
            }
          }
          const propOrInexact = this.flowParseObjectTypeProperty(node, isStatic, protoStartLoc, variance, kind, allowSpread, allowInexact != null ? allowInexact : !exact);
          if (propOrInexact === null) {
            inexact = true;
            inexactStartLoc = this.state.lastTokStartLoc;
          } else {
            nodeStart.properties.push(propOrInexact);
          }
        }
        this.flowObjectTypeSemicolon();
        if (inexactStartLoc && !this.match(8) && !this.match(9)) {
          this.raise(FlowErrors.UnexpectedExplicitInexactInObject, inexactStartLoc);
        }
      }
      this.expect(endDelim);
      if (allowSpread) {
        nodeStart.inexact = inexact;
      }
      const out = this.finishNode(nodeStart, "ObjectTypeAnnotation");
      this.state.inType = oldInType;
      return out;
    }
    flowParseObjectTypeProperty(node, isStatic, protoStartLoc, variance, kind, allowSpread, allowInexact) {
      if (this.eat(21)) {
        const isInexactToken = this.match(12) || this.match(13) || this.match(8) || this.match(9);
        if (isInexactToken) {
          if (!allowSpread) {
            this.raise(FlowErrors.InexactInsideNonObject, this.state.lastTokStartLoc);
          } else if (!allowInexact) {
            this.raise(FlowErrors.InexactInsideExact, this.state.lastTokStartLoc);
          }
          if (variance) {
            this.raise(FlowErrors.InexactVariance, variance);
          }
          return null;
        }
        if (!allowSpread) {
          this.raise(FlowErrors.UnexpectedSpreadType, this.state.lastTokStartLoc);
        }
        if (protoStartLoc != null) {
          this.unexpected(protoStartLoc);
        }
        if (variance) {
          this.raise(FlowErrors.SpreadVariance, variance);
        }
        node.argument = this.flowParseType();
        return this.finishNode(node, "ObjectTypeSpreadProperty");
      } else {
        node.key = this.flowParseObjectPropertyKey();
        node.static = isStatic;
        node.proto = protoStartLoc != null;
        node.kind = kind;
        let optional = false;
        if (this.match(47) || this.match(10)) {
          node.method = true;
          if (protoStartLoc != null) {
            this.unexpected(protoStartLoc);
          }
          if (variance) {
            this.unexpected(variance.loc.start);
          }
          node.value = this.flowParseObjectTypeMethodish(this.startNodeAt(node.loc.start));
          if (kind === "get" || kind === "set") {
            this.flowCheckGetterSetterParams(node);
          }
          if (!allowSpread && node.key.name === "constructor" && node.value.this) {
            this.raise(FlowErrors.ThisParamBannedInConstructor, node.value.this);
          }
        } else {
          if (kind !== "init")
            this.unexpected();
          node.method = false;
          if (this.eat(17)) {
            optional = true;
          }
          node.value = this.flowParseTypeInitialiser();
          node.variance = variance;
        }
        node.optional = optional;
        return this.finishNode(node, "ObjectTypeProperty");
      }
    }
    flowCheckGetterSetterParams(property) {
      const paramCount = property.kind === "get" ? 0 : 1;
      const length = property.value.params.length + (property.value.rest ? 1 : 0);
      if (property.value.this) {
        this.raise(property.kind === "get" ? FlowErrors.GetterMayNotHaveThisParam : FlowErrors.SetterMayNotHaveThisParam, property.value.this);
      }
      if (length !== paramCount) {
        this.raise(property.kind === "get" ? Errors.BadGetterArity : Errors.BadSetterArity, property);
      }
      if (property.kind === "set" && property.value.rest) {
        this.raise(Errors.BadSetterRestParameter, property);
      }
    }
    flowObjectTypeSemicolon() {
      if (!this.eat(13) && !this.eat(12) && !this.match(8) && !this.match(9)) {
        this.unexpected();
      }
    }
    flowParseQualifiedTypeIdentifier(startLoc, id) {
      startLoc != null || (startLoc = this.state.startLoc);
      let node = id || this.flowParseRestrictedIdentifier(true);
      while (this.eat(16)) {
        const node2 = this.startNodeAt(startLoc);
        node2.qualification = node;
        node2.id = this.flowParseRestrictedIdentifier(true);
        node = this.finishNode(node2, "QualifiedTypeIdentifier");
      }
      return node;
    }
    flowParseGenericType(startLoc, id) {
      const node = this.startNodeAt(startLoc);
      node.typeParameters = null;
      node.id = this.flowParseQualifiedTypeIdentifier(startLoc, id);
      if (this.match(47)) {
        node.typeParameters = this.flowParseTypeParameterInstantiation();
      }
      return this.finishNode(node, "GenericTypeAnnotation");
    }
    flowParseTypeofType() {
      const node = this.startNode();
      this.expect(87);
      node.argument = this.flowParsePrimaryType();
      return this.finishNode(node, "TypeofTypeAnnotation");
    }
    flowParseTupleType() {
      const node = this.startNode();
      node.types = [];
      this.expect(0);
      while (this.state.pos < this.length && !this.match(3)) {
        node.types.push(this.flowParseType());
        if (this.match(3))
          break;
        this.expect(12);
      }
      this.expect(3);
      return this.finishNode(node, "TupleTypeAnnotation");
    }
    flowParseFunctionTypeParam(first) {
      let name = null;
      let optional = false;
      let typeAnnotation = null;
      const node = this.startNode();
      const lh = this.lookahead();
      const isThis = this.state.type === 78;
      if (lh.type === 14 || lh.type === 17) {
        if (isThis && !first) {
          this.raise(FlowErrors.ThisParamMustBeFirst, node);
        }
        name = this.parseIdentifier(isThis);
        if (this.eat(17)) {
          optional = true;
          if (isThis) {
            this.raise(FlowErrors.ThisParamMayNotBeOptional, node);
          }
        }
        typeAnnotation = this.flowParseTypeInitialiser();
      } else {
        typeAnnotation = this.flowParseType();
      }
      node.name = name;
      node.optional = optional;
      node.typeAnnotation = typeAnnotation;
      return this.finishNode(node, "FunctionTypeParam");
    }
    reinterpretTypeAsFunctionTypeParam(type) {
      const node = this.startNodeAt(type.loc.start);
      node.name = null;
      node.optional = false;
      node.typeAnnotation = type;
      return this.finishNode(node, "FunctionTypeParam");
    }
    flowParseFunctionTypeParams(params = []) {
      let rest = null;
      let _this = null;
      if (this.match(78)) {
        _this = this.flowParseFunctionTypeParam(true);
        _this.name = null;
        if (!this.match(11)) {
          this.expect(12);
        }
      }
      while (!this.match(11) && !this.match(21)) {
        params.push(this.flowParseFunctionTypeParam(false));
        if (!this.match(11)) {
          this.expect(12);
        }
      }
      if (this.eat(21)) {
        rest = this.flowParseFunctionTypeParam(false);
      }
      return {
        params,
        rest,
        _this
      };
    }
    flowIdentToTypeAnnotation(startLoc, node, id) {
      switch (id.name) {
        case "any":
          return this.finishNode(node, "AnyTypeAnnotation");
        case "bool":
        case "boolean":
          return this.finishNode(node, "BooleanTypeAnnotation");
        case "mixed":
          return this.finishNode(node, "MixedTypeAnnotation");
        case "empty":
          return this.finishNode(node, "EmptyTypeAnnotation");
        case "number":
          return this.finishNode(node, "NumberTypeAnnotation");
        case "string":
          return this.finishNode(node, "StringTypeAnnotation");
        case "symbol":
          return this.finishNode(node, "SymbolTypeAnnotation");
        default:
          this.checkNotUnderscore(id.name);
          return this.flowParseGenericType(startLoc, id);
      }
    }
    flowParsePrimaryType() {
      const startLoc = this.state.startLoc;
      const node = this.startNode();
      let tmp;
      let type;
      let isGroupedType = false;
      const oldNoAnonFunctionType = this.state.noAnonFunctionType;
      switch (this.state.type) {
        case 5:
          return this.flowParseObjectType({
            allowStatic: false,
            allowExact: false,
            allowSpread: true,
            allowProto: false,
            allowInexact: true
          });
        case 6:
          return this.flowParseObjectType({
            allowStatic: false,
            allowExact: true,
            allowSpread: true,
            allowProto: false,
            allowInexact: false
          });
        case 0:
          this.state.noAnonFunctionType = false;
          type = this.flowParseTupleType();
          this.state.noAnonFunctionType = oldNoAnonFunctionType;
          return type;
        case 47: {
          const node2 = this.startNode();
          node2.typeParameters = this.flowParseTypeParameterDeclaration();
          this.expect(10);
          tmp = this.flowParseFunctionTypeParams();
          node2.params = tmp.params;
          node2.rest = tmp.rest;
          node2.this = tmp._this;
          this.expect(11);
          this.expect(19);
          node2.returnType = this.flowParseType();
          return this.finishNode(node2, "FunctionTypeAnnotation");
        }
        case 10: {
          const node2 = this.startNode();
          this.next();
          if (!this.match(11) && !this.match(21)) {
            if (tokenIsIdentifier(this.state.type) || this.match(78)) {
              const token = this.lookahead().type;
              isGroupedType = token !== 17 && token !== 14;
            } else {
              isGroupedType = true;
            }
          }
          if (isGroupedType) {
            this.state.noAnonFunctionType = false;
            type = this.flowParseType();
            this.state.noAnonFunctionType = oldNoAnonFunctionType;
            if (this.state.noAnonFunctionType || !(this.match(12) || this.match(11) && this.lookahead().type === 19)) {
              this.expect(11);
              return type;
            } else {
              this.eat(12);
            }
          }
          if (type) {
            tmp = this.flowParseFunctionTypeParams([this.reinterpretTypeAsFunctionTypeParam(type)]);
          } else {
            tmp = this.flowParseFunctionTypeParams();
          }
          node2.params = tmp.params;
          node2.rest = tmp.rest;
          node2.this = tmp._this;
          this.expect(11);
          this.expect(19);
          node2.returnType = this.flowParseType();
          node2.typeParameters = null;
          return this.finishNode(node2, "FunctionTypeAnnotation");
        }
        case 134:
          return this.parseLiteral(this.state.value, "StringLiteralTypeAnnotation");
        case 85:
        case 86:
          node.value = this.match(85);
          this.next();
          return this.finishNode(node, "BooleanLiteralTypeAnnotation");
        case 53:
          if (this.state.value === "-") {
            this.next();
            if (this.match(135)) {
              return this.parseLiteralAtNode(-this.state.value, "NumberLiteralTypeAnnotation", node);
            }
            if (this.match(136)) {
              return this.parseLiteralAtNode(-this.state.value, "BigIntLiteralTypeAnnotation", node);
            }
            throw this.raise(FlowErrors.UnexpectedSubtractionOperand, this.state.startLoc);
          }
          throw this.unexpected();
        case 135:
          return this.parseLiteral(this.state.value, "NumberLiteralTypeAnnotation");
        case 136:
          return this.parseLiteral(this.state.value, "BigIntLiteralTypeAnnotation");
        case 88:
          this.next();
          return this.finishNode(node, "VoidTypeAnnotation");
        case 84:
          this.next();
          return this.finishNode(node, "NullLiteralTypeAnnotation");
        case 78:
          this.next();
          return this.finishNode(node, "ThisTypeAnnotation");
        case 55:
          this.next();
          return this.finishNode(node, "ExistsTypeAnnotation");
        case 87:
          return this.flowParseTypeofType();
        default:
          if (tokenIsKeyword(this.state.type)) {
            const label = tokenLabelName(this.state.type);
            this.next();
            return super.createIdentifier(node, label);
          } else if (tokenIsIdentifier(this.state.type)) {
            if (this.isContextual(129)) {
              return this.flowParseInterfaceType();
            }
            return this.flowIdentToTypeAnnotation(startLoc, node, this.parseIdentifier());
          }
      }
      throw this.unexpected();
    }
    flowParsePostfixType() {
      const startLoc = this.state.startLoc;
      let type = this.flowParsePrimaryType();
      let seenOptionalIndexedAccess = false;
      while ((this.match(0) || this.match(18)) && !this.canInsertSemicolon()) {
        const node = this.startNodeAt(startLoc);
        const optional = this.eat(18);
        seenOptionalIndexedAccess = seenOptionalIndexedAccess || optional;
        this.expect(0);
        if (!optional && this.match(3)) {
          node.elementType = type;
          this.next();
          type = this.finishNode(node, "ArrayTypeAnnotation");
        } else {
          node.objectType = type;
          node.indexType = this.flowParseType();
          this.expect(3);
          if (seenOptionalIndexedAccess) {
            node.optional = optional;
            type = this.finishNode(node, "OptionalIndexedAccessType");
          } else {
            type = this.finishNode(node, "IndexedAccessType");
          }
        }
      }
      return type;
    }
    flowParsePrefixType() {
      const node = this.startNode();
      if (this.eat(17)) {
        node.typeAnnotation = this.flowParsePrefixType();
        return this.finishNode(node, "NullableTypeAnnotation");
      } else {
        return this.flowParsePostfixType();
      }
    }
    flowParseAnonFunctionWithoutParens() {
      const param = this.flowParsePrefixType();
      if (!this.state.noAnonFunctionType && this.eat(19)) {
        const node = this.startNodeAt(param.loc.start);
        node.params = [this.reinterpretTypeAsFunctionTypeParam(param)];
        node.rest = null;
        node.this = null;
        node.returnType = this.flowParseType();
        node.typeParameters = null;
        return this.finishNode(node, "FunctionTypeAnnotation");
      }
      return param;
    }
    flowParseIntersectionType() {
      const node = this.startNode();
      this.eat(45);
      const type = this.flowParseAnonFunctionWithoutParens();
      node.types = [type];
      while (this.eat(45)) {
        node.types.push(this.flowParseAnonFunctionWithoutParens());
      }
      return node.types.length === 1 ? type : this.finishNode(node, "IntersectionTypeAnnotation");
    }
    flowParseUnionType() {
      const node = this.startNode();
      this.eat(43);
      const type = this.flowParseIntersectionType();
      node.types = [type];
      while (this.eat(43)) {
        node.types.push(this.flowParseIntersectionType());
      }
      return node.types.length === 1 ? type : this.finishNode(node, "UnionTypeAnnotation");
    }
    flowParseType() {
      const oldInType = this.state.inType;
      this.state.inType = true;
      const type = this.flowParseUnionType();
      this.state.inType = oldInType;
      return type;
    }
    flowParseTypeOrImplicitInstantiation() {
      if (this.state.type === 132 && this.state.value === "_") {
        const startLoc = this.state.startLoc;
        const node = this.parseIdentifier();
        return this.flowParseGenericType(startLoc, node);
      } else {
        return this.flowParseType();
      }
    }
    flowParseTypeAnnotation() {
      const node = this.startNode();
      node.typeAnnotation = this.flowParseTypeInitialiser();
      return this.finishNode(node, "TypeAnnotation");
    }
    flowParseTypeAnnotatableIdentifier() {
      const node = this.startNode();
      const name = this.parseIdentifierName();
      if (this.match(14)) {
        node.typeAnnotation = this.flowParseTypeAnnotation();
      }
      return this.createIdentifier(node, name);
    }
    typeCastToParameter(node) {
      node.expression.typeAnnotation = node.typeAnnotation;
      this.resetEndLocation(node.expression, node.typeAnnotation.loc.end);
      return node.expression;
    }
    flowParseVariance() {
      let variance = null;
      if (this.match(53)) {
        variance = this.startNode();
        if (this.state.value === "+") {
          variance.kind = "plus";
        } else {
          variance.kind = "minus";
        }
        this.next();
        return this.finishNode(variance, "Variance");
      }
      return variance;
    }
    parseFunctionBody(node, allowExpressionBody, isMethod = false) {
      if (allowExpressionBody) {
        this.forwardNoArrowParamsConversionAt(node, () => super.parseFunctionBody(node, true, isMethod));
        return;
      }
      super.parseFunctionBody(node, false, isMethod);
    }
    parseFunctionBodyAndFinish(node, type, isMethod = false) {
      if (this.match(14)) {
        const typeNode = this.startNode();
        [typeNode.typeAnnotation, node.predicate] = this.flowParseTypeAndPredicateInitialiser();
        node.returnType = typeNode.typeAnnotation ? this.finishNode(typeNode, "TypeAnnotation") : null;
      }
      return super.parseFunctionBodyAndFinish(node, type, isMethod);
    }
    parseStatementLike(flags) {
      if (this.state.strict && this.isContextual(129)) {
        const lookahead = this.lookahead();
        if (tokenIsKeywordOrIdentifier(lookahead.type)) {
          const node = this.startNode();
          this.next();
          return this.flowParseInterface(node);
        }
      } else if (this.isContextual(126)) {
        const node = this.startNode();
        this.next();
        return this.flowParseEnumDeclaration(node);
      }
      const stmt = super.parseStatementLike(flags);
      if (this.flowPragma === undefined && !this.isValidDirective(stmt)) {
        this.flowPragma = null;
      }
      return stmt;
    }
    parseExpressionStatement(node, expr, decorators) {
      if (expr.type === "Identifier") {
        if (expr.name === "declare") {
          if (this.match(80) || tokenIsIdentifier(this.state.type) || this.match(68) || this.match(74) || this.match(82)) {
            return this.flowParseDeclare(node);
          }
        } else if (tokenIsIdentifier(this.state.type)) {
          if (expr.name === "interface") {
            return this.flowParseInterface(node);
          } else if (expr.name === "type") {
            return this.flowParseTypeAlias(node);
          } else if (expr.name === "opaque") {
            return this.flowParseOpaqueType(node, false);
          }
        }
      }
      return super.parseExpressionStatement(node, expr, decorators);
    }
    shouldParseExportDeclaration() {
      const {
        type
      } = this.state;
      if (type === 126 || tokenIsFlowInterfaceOrTypeOrOpaque(type)) {
        return !this.state.containsEsc;
      }
      return super.shouldParseExportDeclaration();
    }
    isExportDefaultSpecifier() {
      const {
        type
      } = this.state;
      if (type === 126 || tokenIsFlowInterfaceOrTypeOrOpaque(type)) {
        return this.state.containsEsc;
      }
      return super.isExportDefaultSpecifier();
    }
    parseExportDefaultExpression() {
      if (this.isContextual(126)) {
        const node = this.startNode();
        this.next();
        return this.flowParseEnumDeclaration(node);
      }
      return super.parseExportDefaultExpression();
    }
    parseConditional(expr, startLoc, refExpressionErrors) {
      if (!this.match(17))
        return expr;
      if (this.state.maybeInArrowParameters) {
        const nextCh = this.lookaheadCharCode();
        if (nextCh === 44 || nextCh === 61 || nextCh === 58 || nextCh === 41) {
          this.setOptionalParametersError(refExpressionErrors);
          return expr;
        }
      }
      this.expect(17);
      const state = this.state.clone();
      const originalNoArrowAt = this.state.noArrowAt;
      const node = this.startNodeAt(startLoc);
      let {
        consequent,
        failed
      } = this.tryParseConditionalConsequent();
      let [valid, invalid] = this.getArrowLikeExpressions(consequent);
      if (failed || invalid.length > 0) {
        const noArrowAt = [...originalNoArrowAt];
        if (invalid.length > 0) {
          this.state = state;
          this.state.noArrowAt = noArrowAt;
          for (let i = 0;i < invalid.length; i++) {
            noArrowAt.push(invalid[i].start);
          }
          ({
            consequent,
            failed
          } = this.tryParseConditionalConsequent());
          [valid, invalid] = this.getArrowLikeExpressions(consequent);
        }
        if (failed && valid.length > 1) {
          this.raise(FlowErrors.AmbiguousConditionalArrow, state.startLoc);
        }
        if (failed && valid.length === 1) {
          this.state = state;
          noArrowAt.push(valid[0].start);
          this.state.noArrowAt = noArrowAt;
          ({
            consequent,
            failed
          } = this.tryParseConditionalConsequent());
        }
      }
      this.getArrowLikeExpressions(consequent, true);
      this.state.noArrowAt = originalNoArrowAt;
      this.expect(14);
      node.test = expr;
      node.consequent = consequent;
      node.alternate = this.forwardNoArrowParamsConversionAt(node, () => this.parseMaybeAssign(undefined, undefined));
      return this.finishNode(node, "ConditionalExpression");
    }
    tryParseConditionalConsequent() {
      this.state.noArrowParamsConversionAt.push(this.state.start);
      const consequent = this.parseMaybeAssignAllowIn();
      const failed = !this.match(14);
      this.state.noArrowParamsConversionAt.pop();
      return {
        consequent,
        failed
      };
    }
    getArrowLikeExpressions(node, disallowInvalid) {
      const stack = [node];
      const arrows = [];
      while (stack.length !== 0) {
        const node2 = stack.pop();
        if (node2.type === "ArrowFunctionExpression" && node2.body.type !== "BlockStatement") {
          if (node2.typeParameters || !node2.returnType) {
            this.finishArrowValidation(node2);
          } else {
            arrows.push(node2);
          }
          stack.push(node2.body);
        } else if (node2.type === "ConditionalExpression") {
          stack.push(node2.consequent);
          stack.push(node2.alternate);
        }
      }
      if (disallowInvalid) {
        arrows.forEach((node2) => this.finishArrowValidation(node2));
        return [arrows, []];
      }
      return partition(arrows, (node2) => node2.params.every((param) => this.isAssignable(param, true)));
    }
    finishArrowValidation(node) {
      var _node$extra;
      this.toAssignableList(node.params, (_node$extra = node.extra) == null ? undefined : _node$extra.trailingCommaLoc, false);
      this.scope.enter(514 | 4);
      super.checkParams(node, false, true);
      this.scope.exit();
    }
    forwardNoArrowParamsConversionAt(node, parse2) {
      let result;
      if (this.state.noArrowParamsConversionAt.includes(this.offsetToSourcePos(node.start))) {
        this.state.noArrowParamsConversionAt.push(this.state.start);
        result = parse2();
        this.state.noArrowParamsConversionAt.pop();
      } else {
        result = parse2();
      }
      return result;
    }
    parseParenItem(node, startLoc) {
      const newNode = super.parseParenItem(node, startLoc);
      if (this.eat(17)) {
        newNode.optional = true;
        this.resetEndLocation(node);
      }
      if (this.match(14)) {
        const typeCastNode = this.startNodeAt(startLoc);
        typeCastNode.expression = newNode;
        typeCastNode.typeAnnotation = this.flowParseTypeAnnotation();
        return this.finishNode(typeCastNode, "TypeCastExpression");
      }
      return newNode;
    }
    assertModuleNodeAllowed(node) {
      if (node.type === "ImportDeclaration" && (node.importKind === "type" || node.importKind === "typeof") || node.type === "ExportNamedDeclaration" && node.exportKind === "type" || node.type === "ExportAllDeclaration" && node.exportKind === "type") {
        return;
      }
      super.assertModuleNodeAllowed(node);
    }
    parseExportDeclaration(node) {
      if (this.isContextual(130)) {
        node.exportKind = "type";
        const declarationNode = this.startNode();
        this.next();
        if (this.match(5)) {
          node.specifiers = this.parseExportSpecifiers(true);
          super.parseExportFrom(node);
          return null;
        } else {
          return this.flowParseTypeAlias(declarationNode);
        }
      } else if (this.isContextual(131)) {
        node.exportKind = "type";
        const declarationNode = this.startNode();
        this.next();
        return this.flowParseOpaqueType(declarationNode, false);
      } else if (this.isContextual(129)) {
        node.exportKind = "type";
        const declarationNode = this.startNode();
        this.next();
        return this.flowParseInterface(declarationNode);
      } else if (this.isContextual(126)) {
        node.exportKind = "value";
        const declarationNode = this.startNode();
        this.next();
        return this.flowParseEnumDeclaration(declarationNode);
      } else {
        return super.parseExportDeclaration(node);
      }
    }
    eatExportStar(node) {
      if (super.eatExportStar(node))
        return true;
      if (this.isContextual(130) && this.lookahead().type === 55) {
        node.exportKind = "type";
        this.next();
        this.next();
        return true;
      }
      return false;
    }
    maybeParseExportNamespaceSpecifier(node) {
      const {
        startLoc
      } = this.state;
      const hasNamespace = super.maybeParseExportNamespaceSpecifier(node);
      if (hasNamespace && node.exportKind === "type") {
        this.unexpected(startLoc);
      }
      return hasNamespace;
    }
    parseClassId(node, isStatement, optionalId) {
      super.parseClassId(node, isStatement, optionalId);
      if (this.match(47)) {
        node.typeParameters = this.flowParseTypeParameterDeclaration();
      }
    }
    parseClassMember(classBody, member, state) {
      const {
        startLoc
      } = this.state;
      if (this.isContextual(125)) {
        if (super.parseClassMemberFromModifier(classBody, member)) {
          return;
        }
        member.declare = true;
      }
      super.parseClassMember(classBody, member, state);
      if (member.declare) {
        if (member.type !== "ClassProperty" && member.type !== "ClassPrivateProperty" && member.type !== "PropertyDefinition") {
          this.raise(FlowErrors.DeclareClassElement, startLoc);
        } else if (member.value) {
          this.raise(FlowErrors.DeclareClassFieldInitializer, member.value);
        }
      }
    }
    isIterator(word) {
      return word === "iterator" || word === "asyncIterator";
    }
    readIterator() {
      const word = super.readWord1();
      const fullWord = "@@" + word;
      if (!this.isIterator(word) || !this.state.inType) {
        this.raise(Errors.InvalidIdentifier, this.state.curPosition(), {
          identifierName: fullWord
        });
      }
      this.finishToken(132, fullWord);
    }
    getTokenFromCode(code2) {
      const next = this.input.charCodeAt(this.state.pos + 1);
      if (code2 === 123 && next === 124) {
        this.finishOp(6, 2);
      } else if (this.state.inType && (code2 === 62 || code2 === 60)) {
        this.finishOp(code2 === 62 ? 48 : 47, 1);
      } else if (this.state.inType && code2 === 63) {
        if (next === 46) {
          this.finishOp(18, 2);
        } else {
          this.finishOp(17, 1);
        }
      } else if (isIteratorStart(code2, next, this.input.charCodeAt(this.state.pos + 2))) {
        this.state.pos += 2;
        this.readIterator();
      } else {
        super.getTokenFromCode(code2);
      }
    }
    isAssignable(node, isBinding) {
      if (node.type === "TypeCastExpression") {
        return this.isAssignable(node.expression, isBinding);
      } else {
        return super.isAssignable(node, isBinding);
      }
    }
    toAssignable(node, isLHS = false) {
      if (!isLHS && node.type === "AssignmentExpression" && node.left.type === "TypeCastExpression") {
        node.left = this.typeCastToParameter(node.left);
      }
      super.toAssignable(node, isLHS);
    }
    toAssignableList(exprList, trailingCommaLoc, isLHS) {
      for (let i = 0;i < exprList.length; i++) {
        const expr = exprList[i];
        if ((expr == null ? undefined : expr.type) === "TypeCastExpression") {
          exprList[i] = this.typeCastToParameter(expr);
        }
      }
      super.toAssignableList(exprList, trailingCommaLoc, isLHS);
    }
    toReferencedList(exprList, isParenthesizedExpr) {
      for (let i = 0;i < exprList.length; i++) {
        var _expr$extra;
        const expr = exprList[i];
        if (expr && expr.type === "TypeCastExpression" && !((_expr$extra = expr.extra) != null && _expr$extra.parenthesized) && (exprList.length > 1 || !isParenthesizedExpr)) {
          this.raise(FlowErrors.TypeCastInPattern, expr.typeAnnotation);
        }
      }
      return exprList;
    }
    parseArrayLike(close, isTuple, refExpressionErrors) {
      const node = super.parseArrayLike(close, isTuple, refExpressionErrors);
      if (refExpressionErrors != null && !this.state.maybeInArrowParameters) {
        this.toReferencedList(node.elements);
      }
      return node;
    }
    isValidLVal(type, disallowCallExpression, isParenthesized, binding) {
      return type === "TypeCastExpression" || super.isValidLVal(type, disallowCallExpression, isParenthesized, binding);
    }
    parseClassProperty(node) {
      if (this.match(14)) {
        node.typeAnnotation = this.flowParseTypeAnnotation();
      }
      return super.parseClassProperty(node);
    }
    parseClassPrivateProperty(node) {
      if (this.match(14)) {
        node.typeAnnotation = this.flowParseTypeAnnotation();
      }
      return super.parseClassPrivateProperty(node);
    }
    isClassMethod() {
      return this.match(47) || super.isClassMethod();
    }
    isClassProperty() {
      return this.match(14) || super.isClassProperty();
    }
    isNonstaticConstructor(method) {
      return !this.match(14) && super.isNonstaticConstructor(method);
    }
    pushClassMethod(classBody, method, isGenerator, isAsync, isConstructor, allowsDirectSuper) {
      if (method.variance) {
        this.unexpected(method.variance.loc.start);
      }
      delete method.variance;
      if (this.match(47)) {
        method.typeParameters = this.flowParseTypeParameterDeclaration();
      }
      super.pushClassMethod(classBody, method, isGenerator, isAsync, isConstructor, allowsDirectSuper);
      if (method.params && isConstructor) {
        const params = method.params;
        if (params.length > 0 && this.isThisParam(params[0])) {
          this.raise(FlowErrors.ThisParamBannedInConstructor, method);
        }
      } else if (method.type === "MethodDefinition" && isConstructor && method.value.params) {
        const params = method.value.params;
        if (params.length > 0 && this.isThisParam(params[0])) {
          this.raise(FlowErrors.ThisParamBannedInConstructor, method);
        }
      }
    }
    pushClassPrivateMethod(classBody, method, isGenerator, isAsync) {
      if (method.variance) {
        this.unexpected(method.variance.loc.start);
      }
      delete method.variance;
      if (this.match(47)) {
        method.typeParameters = this.flowParseTypeParameterDeclaration();
      }
      super.pushClassPrivateMethod(classBody, method, isGenerator, isAsync);
    }
    parseClassSuper(node) {
      super.parseClassSuper(node);
      if (node.superClass && (this.match(47) || this.match(51))) {
        node.superTypeParameters = this.flowParseTypeParameterInstantiationInExpression();
      }
      if (this.isContextual(113)) {
        this.next();
        const implemented = node.implements = [];
        do {
          const node2 = this.startNode();
          node2.id = this.flowParseRestrictedIdentifier(true);
          if (this.match(47)) {
            node2.typeParameters = this.flowParseTypeParameterInstantiation();
          } else {
            node2.typeParameters = null;
          }
          implemented.push(this.finishNode(node2, "ClassImplements"));
        } while (this.eat(12));
      }
    }
    checkGetterSetterParams(method) {
      super.checkGetterSetterParams(method);
      const params = this.getObjectOrClassMethodParams(method);
      if (params.length > 0) {
        const param = params[0];
        if (this.isThisParam(param) && method.kind === "get") {
          this.raise(FlowErrors.GetterMayNotHaveThisParam, param);
        } else if (this.isThisParam(param)) {
          this.raise(FlowErrors.SetterMayNotHaveThisParam, param);
        }
      }
    }
    parsePropertyNamePrefixOperator(node) {
      node.variance = this.flowParseVariance();
    }
    parseObjPropValue(prop, startLoc, isGenerator, isAsync, isPattern, isAccessor, refExpressionErrors) {
      if (prop.variance) {
        this.unexpected(prop.variance.loc.start);
      }
      delete prop.variance;
      let typeParameters;
      if (this.match(47) && !isAccessor) {
        typeParameters = this.flowParseTypeParameterDeclaration();
        if (!this.match(10))
          this.unexpected();
      }
      const result = super.parseObjPropValue(prop, startLoc, isGenerator, isAsync, isPattern, isAccessor, refExpressionErrors);
      if (typeParameters) {
        (result.value || result).typeParameters = typeParameters;
      }
      return result;
    }
    parseFunctionParamType(param) {
      if (this.eat(17)) {
        if (param.type !== "Identifier") {
          this.raise(FlowErrors.PatternIsOptional, param);
        }
        if (this.isThisParam(param)) {
          this.raise(FlowErrors.ThisParamMayNotBeOptional, param);
        }
        param.optional = true;
      }
      if (this.match(14)) {
        param.typeAnnotation = this.flowParseTypeAnnotation();
      } else if (this.isThisParam(param)) {
        this.raise(FlowErrors.ThisParamAnnotationRequired, param);
      }
      if (this.match(29) && this.isThisParam(param)) {
        this.raise(FlowErrors.ThisParamNoDefault, param);
      }
      this.resetEndLocation(param);
      return param;
    }
    parseMaybeDefault(startLoc, left) {
      const node = super.parseMaybeDefault(startLoc, left);
      if (node.type === "AssignmentPattern" && node.typeAnnotation && node.right.start < node.typeAnnotation.start) {
        this.raise(FlowErrors.TypeBeforeInitializer, node.typeAnnotation);
      }
      return node;
    }
    checkImportReflection(node) {
      super.checkImportReflection(node);
      if (node.module && node.importKind !== "value") {
        this.raise(FlowErrors.ImportReflectionHasImportType, node.specifiers[0].loc.start);
      }
    }
    parseImportSpecifierLocal(node, specifier, type) {
      specifier.local = hasTypeImportKind(node) ? this.flowParseRestrictedIdentifier(true, true) : this.parseIdentifier();
      node.specifiers.push(this.finishImportSpecifier(specifier, type));
    }
    isPotentialImportPhase(isExport) {
      if (super.isPotentialImportPhase(isExport))
        return true;
      if (this.isContextual(130)) {
        if (!isExport)
          return true;
        const ch = this.lookaheadCharCode();
        return ch === 123 || ch === 42;
      }
      return !isExport && this.isContextual(87);
    }
    applyImportPhase(node, isExport, phase, loc) {
      super.applyImportPhase(node, isExport, phase, loc);
      if (isExport) {
        if (!phase && this.match(65)) {
          return;
        }
        node.exportKind = phase === "type" ? phase : "value";
      } else {
        if (phase === "type" && this.match(55))
          this.unexpected();
        node.importKind = phase === "type" || phase === "typeof" ? phase : "value";
      }
    }
    parseImportSpecifier(specifier, importedIsString, isInTypeOnlyImport, isMaybeTypeOnly, bindingType) {
      const firstIdent = specifier.imported;
      let specifierTypeKind = null;
      if (firstIdent.type === "Identifier") {
        if (firstIdent.name === "type") {
          specifierTypeKind = "type";
        } else if (firstIdent.name === "typeof") {
          specifierTypeKind = "typeof";
        }
      }
      let isBinding = false;
      if (this.isContextual(93) && !this.isLookaheadContextual("as")) {
        const as_ident = this.parseIdentifier(true);
        if (specifierTypeKind !== null && !tokenIsKeywordOrIdentifier(this.state.type)) {
          specifier.imported = as_ident;
          specifier.importKind = specifierTypeKind;
          specifier.local = this.cloneIdentifier(as_ident);
        } else {
          specifier.imported = firstIdent;
          specifier.importKind = null;
          specifier.local = this.parseIdentifier();
        }
      } else {
        if (specifierTypeKind !== null && tokenIsKeywordOrIdentifier(this.state.type)) {
          specifier.imported = this.parseIdentifier(true);
          specifier.importKind = specifierTypeKind;
        } else {
          if (importedIsString) {
            throw this.raise(Errors.ImportBindingIsString, specifier, {
              importName: firstIdent.value
            });
          }
          specifier.imported = firstIdent;
          specifier.importKind = null;
        }
        if (this.eatContextual(93)) {
          specifier.local = this.parseIdentifier();
        } else {
          isBinding = true;
          specifier.local = this.cloneIdentifier(specifier.imported);
        }
      }
      const specifierIsTypeImport = hasTypeImportKind(specifier);
      if (isInTypeOnlyImport && specifierIsTypeImport) {
        this.raise(FlowErrors.ImportTypeShorthandOnlyInPureImport, specifier);
      }
      if (isInTypeOnlyImport || specifierIsTypeImport) {
        this.checkReservedType(specifier.local.name, specifier.local.loc.start, true);
      }
      if (isBinding && !isInTypeOnlyImport && !specifierIsTypeImport) {
        this.checkReservedWord(specifier.local.name, specifier.loc.start, true, true);
      }
      return this.finishImportSpecifier(specifier, "ImportSpecifier");
    }
    parseBindingAtom() {
      switch (this.state.type) {
        case 78:
          return this.parseIdentifier(true);
        default:
          return super.parseBindingAtom();
      }
    }
    parseFunctionParams(node, isConstructor) {
      const kind = node.kind;
      if (kind !== "get" && kind !== "set" && this.match(47)) {
        node.typeParameters = this.flowParseTypeParameterDeclaration();
      }
      super.parseFunctionParams(node, isConstructor);
    }
    parseVarId(decl, kind) {
      super.parseVarId(decl, kind);
      if (this.match(14)) {
        decl.id.typeAnnotation = this.flowParseTypeAnnotation();
        this.resetEndLocation(decl.id);
      }
    }
    parseAsyncArrowFromCallExpression(node, call) {
      if (this.match(14)) {
        const oldNoAnonFunctionType = this.state.noAnonFunctionType;
        this.state.noAnonFunctionType = true;
        node.returnType = this.flowParseTypeAnnotation();
        this.state.noAnonFunctionType = oldNoAnonFunctionType;
      }
      return super.parseAsyncArrowFromCallExpression(node, call);
    }
    shouldParseAsyncArrow() {
      return this.match(14) || super.shouldParseAsyncArrow();
    }
    parseMaybeAssign(refExpressionErrors, afterLeftParse) {
      var _jsx;
      let state = null;
      let jsx2;
      if (this.hasPlugin("jsx") && (this.match(143) || this.match(47))) {
        state = this.state.clone();
        jsx2 = this.tryParse(() => super.parseMaybeAssign(refExpressionErrors, afterLeftParse), state);
        if (!jsx2.error)
          return jsx2.node;
        const {
          context
        } = this.state;
        const currentContext = context[context.length - 1];
        if (currentContext === types.j_oTag || currentContext === types.j_expr) {
          context.pop();
        }
      }
      if ((_jsx = jsx2) != null && _jsx.error || this.match(47)) {
        var _jsx2, _jsx3;
        state = state || this.state.clone();
        let typeParameters;
        const arrow = this.tryParse((abort) => {
          var _arrowExpression$extr;
          typeParameters = this.flowParseTypeParameterDeclaration();
          const arrowExpression2 = this.forwardNoArrowParamsConversionAt(typeParameters, () => {
            const result = super.parseMaybeAssign(refExpressionErrors, afterLeftParse);
            this.resetStartLocationFromNode(result, typeParameters);
            return result;
          });
          if ((_arrowExpression$extr = arrowExpression2.extra) != null && _arrowExpression$extr.parenthesized)
            abort();
          const expr = this.maybeUnwrapTypeCastExpression(arrowExpression2);
          if (expr.type !== "ArrowFunctionExpression")
            abort();
          expr.typeParameters = typeParameters;
          this.resetStartLocationFromNode(expr, typeParameters);
          return arrowExpression2;
        }, state);
        let arrowExpression = null;
        if (arrow.node && this.maybeUnwrapTypeCastExpression(arrow.node).type === "ArrowFunctionExpression") {
          if (!arrow.error && !arrow.aborted) {
            if (arrow.node.async) {
              this.raise(FlowErrors.UnexpectedTypeParameterBeforeAsyncArrowFunction, typeParameters);
            }
            return arrow.node;
          }
          arrowExpression = arrow.node;
        }
        if ((_jsx2 = jsx2) != null && _jsx2.node) {
          this.state = jsx2.failState;
          return jsx2.node;
        }
        if (arrowExpression) {
          this.state = arrow.failState;
          return arrowExpression;
        }
        if ((_jsx3 = jsx2) != null && _jsx3.thrown)
          throw jsx2.error;
        if (arrow.thrown)
          throw arrow.error;
        throw this.raise(FlowErrors.UnexpectedTokenAfterTypeParameter, typeParameters);
      }
      return super.parseMaybeAssign(refExpressionErrors, afterLeftParse);
    }
    parseArrow(node) {
      if (this.match(14)) {
        const result = this.tryParse(() => {
          const oldNoAnonFunctionType = this.state.noAnonFunctionType;
          this.state.noAnonFunctionType = true;
          const typeNode = this.startNode();
          [typeNode.typeAnnotation, node.predicate] = this.flowParseTypeAndPredicateInitialiser();
          this.state.noAnonFunctionType = oldNoAnonFunctionType;
          if (this.canInsertSemicolon())
            this.unexpected();
          if (!this.match(19))
            this.unexpected();
          return typeNode;
        });
        if (result.thrown)
          return null;
        if (result.error)
          this.state = result.failState;
        node.returnType = result.node.typeAnnotation ? this.finishNode(result.node, "TypeAnnotation") : null;
      }
      return super.parseArrow(node);
    }
    shouldParseArrow(params) {
      return this.match(14) || super.shouldParseArrow(params);
    }
    setArrowFunctionParameters(node, params) {
      if (this.state.noArrowParamsConversionAt.includes(this.offsetToSourcePos(node.start))) {
        node.params = params;
      } else {
        super.setArrowFunctionParameters(node, params);
      }
    }
    checkParams(node, allowDuplicates, isArrowFunction, strictModeChanged = true) {
      if (isArrowFunction && this.state.noArrowParamsConversionAt.includes(this.offsetToSourcePos(node.start))) {
        return;
      }
      for (let i = 0;i < node.params.length; i++) {
        if (this.isThisParam(node.params[i]) && i > 0) {
          this.raise(FlowErrors.ThisParamMustBeFirst, node.params[i]);
        }
      }
      super.checkParams(node, allowDuplicates, isArrowFunction, strictModeChanged);
    }
    parseParenAndDistinguishExpression(canBeArrow) {
      return super.parseParenAndDistinguishExpression(canBeArrow && !this.state.noArrowAt.includes(this.sourceToOffsetPos(this.state.start)));
    }
    parseSubscripts(base, startLoc, noCalls) {
      if (base.type === "Identifier" && base.name === "async" && this.state.noArrowAt.includes(startLoc.index)) {
        this.next();
        const node = this.startNodeAt(startLoc);
        node.callee = base;
        node.arguments = super.parseCallExpressionArguments();
        base = this.finishNode(node, "CallExpression");
      } else if (base.type === "Identifier" && base.name === "async" && this.match(47)) {
        const state = this.state.clone();
        const arrow = this.tryParse((abort) => this.parseAsyncArrowWithTypeParameters(startLoc) || abort(), state);
        if (!arrow.error && !arrow.aborted)
          return arrow.node;
        const result = this.tryParse(() => super.parseSubscripts(base, startLoc, noCalls), state);
        if (result.node && !result.error)
          return result.node;
        if (arrow.node) {
          this.state = arrow.failState;
          return arrow.node;
        }
        if (result.node) {
          this.state = result.failState;
          return result.node;
        }
        throw arrow.error || result.error;
      }
      return super.parseSubscripts(base, startLoc, noCalls);
    }
    parseSubscript(base, startLoc, noCalls, subscriptState) {
      if (this.match(18) && this.isLookaheadToken_lt()) {
        subscriptState.optionalChainMember = true;
        if (noCalls) {
          subscriptState.stop = true;
          return base;
        }
        this.next();
        const node = this.startNodeAt(startLoc);
        node.callee = base;
        node.typeArguments = this.flowParseTypeParameterInstantiationInExpression();
        this.expect(10);
        node.arguments = this.parseCallExpressionArguments();
        node.optional = true;
        return this.finishCallExpression(node, true);
      } else if (!noCalls && this.shouldParseTypes() && (this.match(47) || this.match(51))) {
        const node = this.startNodeAt(startLoc);
        node.callee = base;
        const result = this.tryParse(() => {
          node.typeArguments = this.flowParseTypeParameterInstantiationCallOrNew();
          this.expect(10);
          node.arguments = super.parseCallExpressionArguments();
          if (subscriptState.optionalChainMember) {
            node.optional = false;
          }
          return this.finishCallExpression(node, subscriptState.optionalChainMember);
        });
        if (result.node) {
          if (result.error)
            this.state = result.failState;
          return result.node;
        }
      }
      return super.parseSubscript(base, startLoc, noCalls, subscriptState);
    }
    parseNewCallee(node) {
      super.parseNewCallee(node);
      let targs = null;
      if (this.shouldParseTypes() && this.match(47)) {
        targs = this.tryParse(() => this.flowParseTypeParameterInstantiationCallOrNew()).node;
      }
      node.typeArguments = targs;
    }
    parseAsyncArrowWithTypeParameters(startLoc) {
      const node = this.startNodeAt(startLoc);
      this.parseFunctionParams(node, false);
      if (!this.parseArrow(node))
        return;
      return super.parseArrowExpression(node, undefined, true);
    }
    readToken_mult_modulo(code2) {
      const next = this.input.charCodeAt(this.state.pos + 1);
      if (code2 === 42 && next === 47 && this.state.hasFlowComment) {
        this.state.hasFlowComment = false;
        this.state.pos += 2;
        this.nextToken();
        return;
      }
      super.readToken_mult_modulo(code2);
    }
    readToken_pipe_amp(code2) {
      const next = this.input.charCodeAt(this.state.pos + 1);
      if (code2 === 124 && next === 125) {
        this.finishOp(9, 2);
        return;
      }
      super.readToken_pipe_amp(code2);
    }
    parseTopLevel(file, program) {
      const fileNode = super.parseTopLevel(file, program);
      if (this.state.hasFlowComment) {
        this.raise(FlowErrors.UnterminatedFlowComment, this.state.curPosition());
      }
      return fileNode;
    }
    skipBlockComment() {
      if (this.hasPlugin("flowComments") && this.skipFlowComment()) {
        if (this.state.hasFlowComment) {
          throw this.raise(FlowErrors.NestedFlowComment, this.state.startLoc);
        }
        this.hasFlowCommentCompletion();
        const commentSkip = this.skipFlowComment();
        if (commentSkip) {
          this.state.pos += commentSkip;
          this.state.hasFlowComment = true;
        }
        return;
      }
      return super.skipBlockComment(this.state.hasFlowComment ? "*-/" : "*/");
    }
    skipFlowComment() {
      const {
        pos
      } = this.state;
      let shiftToFirstNonWhiteSpace = 2;
      while ([32, 9].includes(this.input.charCodeAt(pos + shiftToFirstNonWhiteSpace))) {
        shiftToFirstNonWhiteSpace++;
      }
      const ch2 = this.input.charCodeAt(shiftToFirstNonWhiteSpace + pos);
      const ch3 = this.input.charCodeAt(shiftToFirstNonWhiteSpace + pos + 1);
      if (ch2 === 58 && ch3 === 58) {
        return shiftToFirstNonWhiteSpace + 2;
      }
      if (this.input.slice(shiftToFirstNonWhiteSpace + pos, shiftToFirstNonWhiteSpace + pos + 12) === "flow-include") {
        return shiftToFirstNonWhiteSpace + 12;
      }
      if (ch2 === 58 && ch3 !== 58) {
        return shiftToFirstNonWhiteSpace;
      }
      return false;
    }
    hasFlowCommentCompletion() {
      const end = this.input.indexOf("*/", this.state.pos);
      if (end === -1) {
        throw this.raise(Errors.UnterminatedComment, this.state.curPosition());
      }
    }
    flowEnumErrorBooleanMemberNotInitialized(loc, {
      enumName,
      memberName
    }) {
      this.raise(FlowErrors.EnumBooleanMemberNotInitialized, loc, {
        memberName,
        enumName
      });
    }
    flowEnumErrorInvalidMemberInitializer(loc, enumContext) {
      return this.raise(!enumContext.explicitType ? FlowErrors.EnumInvalidMemberInitializerUnknownType : enumContext.explicitType === "symbol" ? FlowErrors.EnumInvalidMemberInitializerSymbolType : FlowErrors.EnumInvalidMemberInitializerPrimaryType, loc, enumContext);
    }
    flowEnumErrorNumberMemberNotInitialized(loc, details) {
      this.raise(FlowErrors.EnumNumberMemberNotInitialized, loc, details);
    }
    flowEnumErrorStringMemberInconsistentlyInitialized(node, details) {
      this.raise(FlowErrors.EnumStringMemberInconsistentlyInitialized, node, details);
    }
    flowEnumMemberInit() {
      const startLoc = this.state.startLoc;
      const endOfInit = () => this.match(12) || this.match(8);
      switch (this.state.type) {
        case 135: {
          const literal = this.parseNumericLiteral(this.state.value);
          if (endOfInit()) {
            return {
              type: "number",
              loc: literal.loc.start,
              value: literal
            };
          }
          return {
            type: "invalid",
            loc: startLoc
          };
        }
        case 134: {
          const literal = this.parseStringLiteral(this.state.value);
          if (endOfInit()) {
            return {
              type: "string",
              loc: literal.loc.start,
              value: literal
            };
          }
          return {
            type: "invalid",
            loc: startLoc
          };
        }
        case 85:
        case 86: {
          const literal = this.parseBooleanLiteral(this.match(85));
          if (endOfInit()) {
            return {
              type: "boolean",
              loc: literal.loc.start,
              value: literal
            };
          }
          return {
            type: "invalid",
            loc: startLoc
          };
        }
        default:
          return {
            type: "invalid",
            loc: startLoc
          };
      }
    }
    flowEnumMemberRaw() {
      const loc = this.state.startLoc;
      const id = this.parseIdentifier(true);
      const init = this.eat(29) ? this.flowEnumMemberInit() : {
        type: "none",
        loc
      };
      return {
        id,
        init
      };
    }
    flowEnumCheckExplicitTypeMismatch(loc, context, expectedType) {
      const {
        explicitType
      } = context;
      if (explicitType === null) {
        return;
      }
      if (explicitType !== expectedType) {
        this.flowEnumErrorInvalidMemberInitializer(loc, context);
      }
    }
    flowEnumMembers({
      enumName,
      explicitType
    }) {
      const seenNames = new Set;
      const members = {
        booleanMembers: [],
        numberMembers: [],
        stringMembers: [],
        defaultedMembers: []
      };
      let hasUnknownMembers = false;
      while (!this.match(8)) {
        if (this.eat(21)) {
          hasUnknownMembers = true;
          break;
        }
        const memberNode = this.startNode();
        const {
          id,
          init
        } = this.flowEnumMemberRaw();
        const memberName = id.name;
        if (memberName === "") {
          continue;
        }
        if (/^[a-z]/.test(memberName)) {
          this.raise(FlowErrors.EnumInvalidMemberName, id, {
            memberName,
            suggestion: memberName[0].toUpperCase() + memberName.slice(1),
            enumName
          });
        }
        if (seenNames.has(memberName)) {
          this.raise(FlowErrors.EnumDuplicateMemberName, id, {
            memberName,
            enumName
          });
        }
        seenNames.add(memberName);
        const context = {
          enumName,
          explicitType,
          memberName
        };
        memberNode.id = id;
        switch (init.type) {
          case "boolean": {
            this.flowEnumCheckExplicitTypeMismatch(init.loc, context, "boolean");
            memberNode.init = init.value;
            members.booleanMembers.push(this.finishNode(memberNode, "EnumBooleanMember"));
            break;
          }
          case "number": {
            this.flowEnumCheckExplicitTypeMismatch(init.loc, context, "number");
            memberNode.init = init.value;
            members.numberMembers.push(this.finishNode(memberNode, "EnumNumberMember"));
            break;
          }
          case "string": {
            this.flowEnumCheckExplicitTypeMismatch(init.loc, context, "string");
            memberNode.init = init.value;
            members.stringMembers.push(this.finishNode(memberNode, "EnumStringMember"));
            break;
          }
          case "invalid": {
            throw this.flowEnumErrorInvalidMemberInitializer(init.loc, context);
          }
          case "none": {
            switch (explicitType) {
              case "boolean":
                this.flowEnumErrorBooleanMemberNotInitialized(init.loc, context);
                break;
              case "number":
                this.flowEnumErrorNumberMemberNotInitialized(init.loc, context);
                break;
              default:
                members.defaultedMembers.push(this.finishNode(memberNode, "EnumDefaultedMember"));
            }
          }
        }
        if (!this.match(8)) {
          this.expect(12);
        }
      }
      return {
        members,
        hasUnknownMembers
      };
    }
    flowEnumStringMembers(initializedMembers, defaultedMembers, {
      enumName
    }) {
      if (initializedMembers.length === 0) {
        return defaultedMembers;
      } else if (defaultedMembers.length === 0) {
        return initializedMembers;
      } else if (defaultedMembers.length > initializedMembers.length) {
        for (const member of initializedMembers) {
          this.flowEnumErrorStringMemberInconsistentlyInitialized(member, {
            enumName
          });
        }
        return defaultedMembers;
      } else {
        for (const member of defaultedMembers) {
          this.flowEnumErrorStringMemberInconsistentlyInitialized(member, {
            enumName
          });
        }
        return initializedMembers;
      }
    }
    flowEnumParseExplicitType({
      enumName
    }) {
      if (!this.eatContextual(102))
        return null;
      if (!tokenIsIdentifier(this.state.type)) {
        throw this.raise(FlowErrors.EnumInvalidExplicitTypeUnknownSupplied, this.state.startLoc, {
          enumName
        });
      }
      const {
        value
      } = this.state;
      this.next();
      if (value !== "boolean" && value !== "number" && value !== "string" && value !== "symbol") {
        this.raise(FlowErrors.EnumInvalidExplicitType, this.state.startLoc, {
          enumName,
          invalidEnumType: value
        });
      }
      return value;
    }
    flowEnumBody(node, id) {
      const enumName = id.name;
      const nameLoc = id.loc.start;
      const explicitType = this.flowEnumParseExplicitType({
        enumName
      });
      this.expect(5);
      const {
        members,
        hasUnknownMembers
      } = this.flowEnumMembers({
        enumName,
        explicitType
      });
      node.hasUnknownMembers = hasUnknownMembers;
      switch (explicitType) {
        case "boolean":
          node.explicitType = true;
          node.members = members.booleanMembers;
          this.expect(8);
          return this.finishNode(node, "EnumBooleanBody");
        case "number":
          node.explicitType = true;
          node.members = members.numberMembers;
          this.expect(8);
          return this.finishNode(node, "EnumNumberBody");
        case "string":
          node.explicitType = true;
          node.members = this.flowEnumStringMembers(members.stringMembers, members.defaultedMembers, {
            enumName
          });
          this.expect(8);
          return this.finishNode(node, "EnumStringBody");
        case "symbol":
          node.members = members.defaultedMembers;
          this.expect(8);
          return this.finishNode(node, "EnumSymbolBody");
        default: {
          const empty = () => {
            node.members = [];
            this.expect(8);
            return this.finishNode(node, "EnumStringBody");
          };
          node.explicitType = false;
          const boolsLen = members.booleanMembers.length;
          const numsLen = members.numberMembers.length;
          const strsLen = members.stringMembers.length;
          const defaultedLen = members.defaultedMembers.length;
          if (!boolsLen && !numsLen && !strsLen && !defaultedLen) {
            return empty();
          } else if (!boolsLen && !numsLen) {
            node.members = this.flowEnumStringMembers(members.stringMembers, members.defaultedMembers, {
              enumName
            });
            this.expect(8);
            return this.finishNode(node, "EnumStringBody");
          } else if (!numsLen && !strsLen && boolsLen >= defaultedLen) {
            for (const member of members.defaultedMembers) {
              this.flowEnumErrorBooleanMemberNotInitialized(member.loc.start, {
                enumName,
                memberName: member.id.name
              });
            }
            node.members = members.booleanMembers;
            this.expect(8);
            return this.finishNode(node, "EnumBooleanBody");
          } else if (!boolsLen && !strsLen && numsLen >= defaultedLen) {
            for (const member of members.defaultedMembers) {
              this.flowEnumErrorNumberMemberNotInitialized(member.loc.start, {
                enumName,
                memberName: member.id.name
              });
            }
            node.members = members.numberMembers;
            this.expect(8);
            return this.finishNode(node, "EnumNumberBody");
          } else {
            this.raise(FlowErrors.EnumInconsistentMemberValues, nameLoc, {
              enumName
            });
            return empty();
          }
        }
      }
    }
    flowParseEnumDeclaration(node) {
      const id = this.parseIdentifier();
      node.id = id;
      node.body = this.flowEnumBody(this.startNode(), id);
      return this.finishNode(node, "EnumDeclaration");
    }
    jsxParseOpeningElementAfterName(node) {
      if (this.shouldParseTypes()) {
        if (this.match(47) || this.match(51)) {
          node.typeArguments = this.flowParseTypeParameterInstantiationInExpression();
        }
      }
      return super.jsxParseOpeningElementAfterName(node);
    }
    isLookaheadToken_lt() {
      const next = this.nextTokenStart();
      if (this.input.charCodeAt(next) === 60) {
        const afterNext = this.input.charCodeAt(next + 1);
        return afterNext !== 60 && afterNext !== 61;
      }
      return false;
    }
    reScan_lt_gt() {
      const {
        type
      } = this.state;
      if (type === 47) {
        this.state.pos -= 1;
        this.readToken_lt();
      } else if (type === 48) {
        this.state.pos -= 1;
        this.readToken_gt();
      }
    }
    reScan_lt() {
      const {
        type
      } = this.state;
      if (type === 51) {
        this.state.pos -= 2;
        this.finishOp(47, 1);
        return 47;
      }
      return type;
    }
    maybeUnwrapTypeCastExpression(node) {
      return node.type === "TypeCastExpression" ? node.expression : node;
    }
  };
  var entities = {
    __proto__: null,
    quot: '"',
    amp: "&",
    apos: "'",
    lt: "<",
    gt: ">",
    nbsp: "\xA0",
    iexcl: "\xA1",
    cent: "\xA2",
    pound: "\xA3",
    curren: "\xA4",
    yen: "\xA5",
    brvbar: "\xA6",
    sect: "\xA7",
    uml: "\xA8",
    copy: "\xA9",
    ordf: "\xAA",
    laquo: "\xAB",
    not: "\xAC",
    shy: "\xAD",
    reg: "\xAE",
    macr: "\xAF",
    deg: "\xB0",
    plusmn: "\xB1",
    sup2: "\xB2",
    sup3: "\xB3",
    acute: "\xB4",
    micro: "\xB5",
    para: "\xB6",
    middot: "\xB7",
    cedil: "\xB8",
    sup1: "\xB9",
    ordm: "\xBA",
    raquo: "\xBB",
    frac14: "\xBC",
    frac12: "\xBD",
    frac34: "\xBE",
    iquest: "\xBF",
    Agrave: "\xC0",
    Aacute: "\xC1",
    Acirc: "\xC2",
    Atilde: "\xC3",
    Auml: "\xC4",
    Aring: "\xC5",
    AElig: "\xC6",
    Ccedil: "\xC7",
    Egrave: "\xC8",
    Eacute: "\xC9",
    Ecirc: "\xCA",
    Euml: "\xCB",
    Igrave: "\xCC",
    Iacute: "\xCD",
    Icirc: "\xCE",
    Iuml: "\xCF",
    ETH: "\xD0",
    Ntilde: "\xD1",
    Ograve: "\xD2",
    Oacute: "\xD3",
    Ocirc: "\xD4",
    Otilde: "\xD5",
    Ouml: "\xD6",
    times: "\xD7",
    Oslash: "\xD8",
    Ugrave: "\xD9",
    Uacute: "\xDA",
    Ucirc: "\xDB",
    Uuml: "\xDC",
    Yacute: "\xDD",
    THORN: "\xDE",
    szlig: "\xDF",
    agrave: "\xE0",
    aacute: "\xE1",
    acirc: "\xE2",
    atilde: "\xE3",
    auml: "\xE4",
    aring: "\xE5",
    aelig: "\xE6",
    ccedil: "\xE7",
    egrave: "\xE8",
    eacute: "\xE9",
    ecirc: "\xEA",
    euml: "\xEB",
    igrave: "\xEC",
    iacute: "\xED",
    icirc: "\xEE",
    iuml: "\xEF",
    eth: "\xF0",
    ntilde: "\xF1",
    ograve: "\xF2",
    oacute: "\xF3",
    ocirc: "\xF4",
    otilde: "\xF5",
    ouml: "\xF6",
    divide: "\xF7",
    oslash: "\xF8",
    ugrave: "\xF9",
    uacute: "\xFA",
    ucirc: "\xFB",
    uuml: "\xFC",
    yacute: "\xFD",
    thorn: "\xFE",
    yuml: "\xFF",
    OElig: "\u0152",
    oelig: "\u0153",
    Scaron: "\u0160",
    scaron: "\u0161",
    Yuml: "\u0178",
    fnof: "\u0192",
    circ: "\u02C6",
    tilde: "\u02DC",
    Alpha: "\u0391",
    Beta: "\u0392",
    Gamma: "\u0393",
    Delta: "\u0394",
    Epsilon: "\u0395",
    Zeta: "\u0396",
    Eta: "\u0397",
    Theta: "\u0398",
    Iota: "\u0399",
    Kappa: "\u039A",
    Lambda: "\u039B",
    Mu: "\u039C",
    Nu: "\u039D",
    Xi: "\u039E",
    Omicron: "\u039F",
    Pi: "\u03A0",
    Rho: "\u03A1",
    Sigma: "\u03A3",
    Tau: "\u03A4",
    Upsilon: "\u03A5",
    Phi: "\u03A6",
    Chi: "\u03A7",
    Psi: "\u03A8",
    Omega: "\u03A9",
    alpha: "\u03B1",
    beta: "\u03B2",
    gamma: "\u03B3",
    delta: "\u03B4",
    epsilon: "\u03B5",
    zeta: "\u03B6",
    eta: "\u03B7",
    theta: "\u03B8",
    iota: "\u03B9",
    kappa: "\u03BA",
    lambda: "\u03BB",
    mu: "\u03BC",
    nu: "\u03BD",
    xi: "\u03BE",
    omicron: "\u03BF",
    pi: "\u03C0",
    rho: "\u03C1",
    sigmaf: "\u03C2",
    sigma: "\u03C3",
    tau: "\u03C4",
    upsilon: "\u03C5",
    phi: "\u03C6",
    chi: "\u03C7",
    psi: "\u03C8",
    omega: "\u03C9",
    thetasym: "\u03D1",
    upsih: "\u03D2",
    piv: "\u03D6",
    ensp: "\u2002",
    emsp: "\u2003",
    thinsp: "\u2009",
    zwnj: "\u200C",
    zwj: "\u200D",
    lrm: "\u200E",
    rlm: "\u200F",
    ndash: "\u2013",
    mdash: "\u2014",
    lsquo: "\u2018",
    rsquo: "\u2019",
    sbquo: "\u201A",
    ldquo: "\u201C",
    rdquo: "\u201D",
    bdquo: "\u201E",
    dagger: "\u2020",
    Dagger: "\u2021",
    bull: "\u2022",
    hellip: "\u2026",
    permil: "\u2030",
    prime: "\u2032",
    Prime: "\u2033",
    lsaquo: "\u2039",
    rsaquo: "\u203A",
    oline: "\u203E",
    frasl: "\u2044",
    euro: "\u20AC",
    image: "\u2111",
    weierp: "\u2118",
    real: "\u211C",
    trade: "\u2122",
    alefsym: "\u2135",
    larr: "\u2190",
    uarr: "\u2191",
    rarr: "\u2192",
    darr: "\u2193",
    harr: "\u2194",
    crarr: "\u21B5",
    lArr: "\u21D0",
    uArr: "\u21D1",
    rArr: "\u21D2",
    dArr: "\u21D3",
    hArr: "\u21D4",
    forall: "\u2200",
    part: "\u2202",
    exist: "\u2203",
    empty: "\u2205",
    nabla: "\u2207",
    isin: "\u2208",
    notin: "\u2209",
    ni: "\u220B",
    prod: "\u220F",
    sum: "\u2211",
    minus: "\u2212",
    lowast: "\u2217",
    radic: "\u221A",
    prop: "\u221D",
    infin: "\u221E",
    ang: "\u2220",
    and: "\u2227",
    or: "\u2228",
    cap: "\u2229",
    cup: "\u222A",
    int: "\u222B",
    there4: "\u2234",
    sim: "\u223C",
    cong: "\u2245",
    asymp: "\u2248",
    ne: "\u2260",
    equiv: "\u2261",
    le: "\u2264",
    ge: "\u2265",
    sub: "\u2282",
    sup: "\u2283",
    nsub: "\u2284",
    sube: "\u2286",
    supe: "\u2287",
    oplus: "\u2295",
    otimes: "\u2297",
    perp: "\u22A5",
    sdot: "\u22C5",
    lceil: "\u2308",
    rceil: "\u2309",
    lfloor: "\u230A",
    rfloor: "\u230B",
    lang: "\u2329",
    rang: "\u232A",
    loz: "\u25CA",
    spades: "\u2660",
    clubs: "\u2663",
    hearts: "\u2665",
    diams: "\u2666"
  };
  var lineBreak = /\r\n|[\r\n\u2028\u2029]/;
  var lineBreakG = new RegExp(lineBreak.source, "g");
  function isNewLine(code2) {
    switch (code2) {
      case 10:
      case 13:
      case 8232:
      case 8233:
        return true;
      default:
        return false;
    }
  }
  function hasNewLine(input, start, end) {
    for (let i = start;i < end; i++) {
      if (isNewLine(input.charCodeAt(i))) {
        return true;
      }
    }
    return false;
  }
  var skipWhiteSpace = /(?:\s|\/\/.*|\/\*[^]*?\*\/)*/g;
  var skipWhiteSpaceInLine = /(?:[^\S\n\r\u2028\u2029]|\/\/.*|\/\*.*?\*\/)*/g;
  function isWhitespace(code2) {
    switch (code2) {
      case 9:
      case 11:
      case 12:
      case 32:
      case 160:
      case 5760:
      case 8192:
      case 8193:
      case 8194:
      case 8195:
      case 8196:
      case 8197:
      case 8198:
      case 8199:
      case 8200:
      case 8201:
      case 8202:
      case 8239:
      case 8287:
      case 12288:
      case 65279:
        return true;
      default:
        return false;
    }
  }
  var JsxErrors = ParseErrorEnum`jsx`({
    AttributeIsEmpty: "JSX attributes must only be assigned a non-empty expression.",
    MissingClosingTagElement: ({
      openingTagName
    }) => `Expected corresponding JSX closing tag for <${openingTagName}>.`,
    MissingClosingTagFragment: "Expected corresponding JSX closing tag for <>.",
    UnexpectedSequenceExpression: "Sequence expressions cannot be directly nested inside JSX. Did you mean to wrap it in parentheses (...)?",
    UnexpectedToken: ({
      unexpected,
      HTMLEntity
    }) => `Unexpected token \`${unexpected}\`. Did you mean \`${HTMLEntity}\` or \`{'${unexpected}'}\`?`,
    UnsupportedJsxValue: "JSX value should be either an expression or a quoted JSX text.",
    UnterminatedJsxContent: "Unterminated JSX contents.",
    UnwrappedAdjacentJSXElements: "Adjacent JSX elements must be wrapped in an enclosing tag. Did you want a JSX fragment <>...</>?"
  });
  function isFragment(object) {
    return object ? object.type === "JSXOpeningFragment" || object.type === "JSXClosingFragment" : false;
  }
  function getQualifiedJSXName(object) {
    if (object.type === "JSXIdentifier") {
      return object.name;
    }
    if (object.type === "JSXNamespacedName") {
      return object.namespace.name + ":" + object.name.name;
    }
    if (object.type === "JSXMemberExpression") {
      return getQualifiedJSXName(object.object) + "." + getQualifiedJSXName(object.property);
    }
    throw new Error("Node had unexpected type: " + object.type);
  }
  var jsx = (superClass) => class JSXParserMixin extends superClass {
    jsxReadToken() {
      let out = "";
      let chunkStart = this.state.pos;
      for (;; ) {
        if (this.state.pos >= this.length) {
          throw this.raise(JsxErrors.UnterminatedJsxContent, this.state.startLoc);
        }
        const ch = this.input.charCodeAt(this.state.pos);
        switch (ch) {
          case 60:
          case 123:
            if (this.state.pos === this.state.start) {
              if (ch === 60 && this.state.canStartJSXElement) {
                ++this.state.pos;
                this.finishToken(143);
              } else {
                super.getTokenFromCode(ch);
              }
              return;
            }
            out += this.input.slice(chunkStart, this.state.pos);
            this.finishToken(142, out);
            return;
          case 38:
            out += this.input.slice(chunkStart, this.state.pos);
            out += this.jsxReadEntity();
            chunkStart = this.state.pos;
            break;
          case 62:
          case 125:
          default:
            if (isNewLine(ch)) {
              out += this.input.slice(chunkStart, this.state.pos);
              out += this.jsxReadNewLine(true);
              chunkStart = this.state.pos;
            } else {
              ++this.state.pos;
            }
        }
      }
    }
    jsxReadNewLine(normalizeCRLF) {
      const ch = this.input.charCodeAt(this.state.pos);
      let out;
      ++this.state.pos;
      if (ch === 13 && this.input.charCodeAt(this.state.pos) === 10) {
        ++this.state.pos;
        out = normalizeCRLF ? `
` : `\r
`;
      } else {
        out = String.fromCharCode(ch);
      }
      ++this.state.curLine;
      this.state.lineStart = this.state.pos;
      return out;
    }
    jsxReadString(quote) {
      let out = "";
      let chunkStart = ++this.state.pos;
      for (;; ) {
        if (this.state.pos >= this.length) {
          throw this.raise(Errors.UnterminatedString, this.state.startLoc);
        }
        const ch = this.input.charCodeAt(this.state.pos);
        if (ch === quote)
          break;
        if (ch === 38) {
          out += this.input.slice(chunkStart, this.state.pos);
          out += this.jsxReadEntity();
          chunkStart = this.state.pos;
        } else if (isNewLine(ch)) {
          out += this.input.slice(chunkStart, this.state.pos);
          out += this.jsxReadNewLine(false);
          chunkStart = this.state.pos;
        } else {
          ++this.state.pos;
        }
      }
      out += this.input.slice(chunkStart, this.state.pos++);
      this.finishToken(134, out);
    }
    jsxReadEntity() {
      const startPos = ++this.state.pos;
      if (this.codePointAtPos(this.state.pos) === 35) {
        ++this.state.pos;
        let radix = 10;
        if (this.codePointAtPos(this.state.pos) === 120) {
          radix = 16;
          ++this.state.pos;
        }
        const codePoint = this.readInt(radix, undefined, false, "bail");
        if (codePoint !== null && this.codePointAtPos(this.state.pos) === 59) {
          ++this.state.pos;
          return String.fromCodePoint(codePoint);
        }
      } else {
        let count = 0;
        let semi = false;
        while (count++ < 10 && this.state.pos < this.length && !(semi = this.codePointAtPos(this.state.pos) === 59)) {
          ++this.state.pos;
        }
        if (semi) {
          const desc = this.input.slice(startPos, this.state.pos);
          const entity = entities[desc];
          ++this.state.pos;
          if (entity) {
            return entity;
          }
        }
      }
      this.state.pos = startPos;
      return "&";
    }
    jsxReadWord() {
      let ch;
      const start = this.state.pos;
      do {
        ch = this.input.charCodeAt(++this.state.pos);
      } while (isIdentifierChar(ch) || ch === 45);
      this.finishToken(141, this.input.slice(start, this.state.pos));
    }
    jsxParseIdentifier() {
      const node = this.startNode();
      if (this.match(141)) {
        node.name = this.state.value;
      } else if (tokenIsKeyword(this.state.type)) {
        node.name = tokenLabelName(this.state.type);
      } else {
        this.unexpected();
      }
      this.next();
      return this.finishNode(node, "JSXIdentifier");
    }
    jsxParseNamespacedName() {
      const startLoc = this.state.startLoc;
      const name = this.jsxParseIdentifier();
      if (!this.eat(14))
        return name;
      const node = this.startNodeAt(startLoc);
      node.namespace = name;
      node.name = this.jsxParseIdentifier();
      return this.finishNode(node, "JSXNamespacedName");
    }
    jsxParseElementName() {
      const startLoc = this.state.startLoc;
      let node = this.jsxParseNamespacedName();
      if (node.type === "JSXNamespacedName") {
        return node;
      }
      while (this.eat(16)) {
        const newNode = this.startNodeAt(startLoc);
        newNode.object = node;
        newNode.property = this.jsxParseIdentifier();
        node = this.finishNode(newNode, "JSXMemberExpression");
      }
      return node;
    }
    jsxParseAttributeValue() {
      let node;
      switch (this.state.type) {
        case 5:
          node = this.startNode();
          this.setContext(types.brace);
          this.next();
          node = this.jsxParseExpressionContainer(node, types.j_oTag);
          if (node.expression.type === "JSXEmptyExpression") {
            this.raise(JsxErrors.AttributeIsEmpty, node);
          }
          return node;
        case 143:
        case 134:
          return this.parseExprAtom();
        default:
          throw this.raise(JsxErrors.UnsupportedJsxValue, this.state.startLoc);
      }
    }
    jsxParseEmptyExpression() {
      const node = this.startNodeAt(this.state.lastTokEndLoc);
      return this.finishNodeAt(node, "JSXEmptyExpression", this.state.startLoc);
    }
    jsxParseSpreadChild(node) {
      this.next();
      node.expression = this.parseExpression();
      this.setContext(types.j_expr);
      this.state.canStartJSXElement = true;
      this.expect(8);
      return this.finishNode(node, "JSXSpreadChild");
    }
    jsxParseExpressionContainer(node, previousContext) {
      if (this.match(8)) {
        node.expression = this.jsxParseEmptyExpression();
      } else {
        const expression = this.parseExpression();
        node.expression = expression;
      }
      this.setContext(previousContext);
      this.state.canStartJSXElement = true;
      this.expect(8);
      return this.finishNode(node, "JSXExpressionContainer");
    }
    jsxParseAttribute() {
      const node = this.startNode();
      if (this.match(5)) {
        this.setContext(types.brace);
        this.next();
        this.expect(21);
        node.argument = this.parseMaybeAssignAllowIn();
        this.setContext(types.j_oTag);
        this.state.canStartJSXElement = true;
        this.expect(8);
        return this.finishNode(node, "JSXSpreadAttribute");
      }
      node.name = this.jsxParseNamespacedName();
      node.value = this.eat(29) ? this.jsxParseAttributeValue() : null;
      return this.finishNode(node, "JSXAttribute");
    }
    jsxParseOpeningElementAt(startLoc) {
      const node = this.startNodeAt(startLoc);
      if (this.eat(144)) {
        return this.finishNode(node, "JSXOpeningFragment");
      }
      node.name = this.jsxParseElementName();
      return this.jsxParseOpeningElementAfterName(node);
    }
    jsxParseOpeningElementAfterName(node) {
      const attributes = [];
      while (!this.match(56) && !this.match(144)) {
        attributes.push(this.jsxParseAttribute());
      }
      node.attributes = attributes;
      node.selfClosing = this.eat(56);
      this.expect(144);
      return this.finishNode(node, "JSXOpeningElement");
    }
    jsxParseClosingElementAt(startLoc) {
      const node = this.startNodeAt(startLoc);
      if (this.eat(144)) {
        return this.finishNode(node, "JSXClosingFragment");
      }
      node.name = this.jsxParseElementName();
      this.expect(144);
      return this.finishNode(node, "JSXClosingElement");
    }
    jsxParseElementAt(startLoc) {
      const node = this.startNodeAt(startLoc);
      const children = [];
      const openingElement = this.jsxParseOpeningElementAt(startLoc);
      let closingElement = null;
      if (!openingElement.selfClosing) {
        contents:
          for (;; ) {
            switch (this.state.type) {
              case 143:
                startLoc = this.state.startLoc;
                this.next();
                if (this.eat(56)) {
                  closingElement = this.jsxParseClosingElementAt(startLoc);
                  break contents;
                }
                children.push(this.jsxParseElementAt(startLoc));
                break;
              case 142:
                children.push(this.parseLiteral(this.state.value, "JSXText"));
                break;
              case 5: {
                const node2 = this.startNode();
                this.setContext(types.brace);
                this.next();
                if (this.match(21)) {
                  children.push(this.jsxParseSpreadChild(node2));
                } else {
                  children.push(this.jsxParseExpressionContainer(node2, types.j_expr));
                }
                break;
              }
              default:
                this.unexpected();
            }
          }
        if (isFragment(openingElement) && !isFragment(closingElement) && closingElement !== null) {
          this.raise(JsxErrors.MissingClosingTagFragment, closingElement);
        } else if (!isFragment(openingElement) && isFragment(closingElement)) {
          this.raise(JsxErrors.MissingClosingTagElement, closingElement, {
            openingTagName: getQualifiedJSXName(openingElement.name)
          });
        } else if (!isFragment(openingElement) && !isFragment(closingElement)) {
          if (getQualifiedJSXName(closingElement.name) !== getQualifiedJSXName(openingElement.name)) {
            this.raise(JsxErrors.MissingClosingTagElement, closingElement, {
              openingTagName: getQualifiedJSXName(openingElement.name)
            });
          }
        }
      }
      if (isFragment(openingElement)) {
        node.openingFragment = openingElement;
        node.closingFragment = closingElement;
      } else {
        node.openingElement = openingElement;
        node.closingElement = closingElement;
      }
      node.children = children;
      if (this.match(47)) {
        throw this.raise(JsxErrors.UnwrappedAdjacentJSXElements, this.state.startLoc);
      }
      return isFragment(openingElement) ? this.finishNode(node, "JSXFragment") : this.finishNode(node, "JSXElement");
    }
    jsxParseElement() {
      const startLoc = this.state.startLoc;
      this.next();
      return this.jsxParseElementAt(startLoc);
    }
    setContext(newContext) {
      const {
        context
      } = this.state;
      context[context.length - 1] = newContext;
    }
    parseExprAtom(refExpressionErrors) {
      if (this.match(143)) {
        return this.jsxParseElement();
      } else if (this.match(47) && this.input.charCodeAt(this.state.pos) !== 33) {
        this.replaceToken(143);
        return this.jsxParseElement();
      } else {
        return super.parseExprAtom(refExpressionErrors);
      }
    }
    skipSpace() {
      const curContext = this.curContext();
      if (!curContext.preserveSpace)
        super.skipSpace();
    }
    getTokenFromCode(code2) {
      const context = this.curContext();
      if (context === types.j_expr) {
        this.jsxReadToken();
        return;
      }
      if (context === types.j_oTag || context === types.j_cTag) {
        if (isIdentifierStart(code2)) {
          this.jsxReadWord();
          return;
        }
        if (code2 === 62) {
          ++this.state.pos;
          this.finishToken(144);
          return;
        }
        if ((code2 === 34 || code2 === 39) && context === types.j_oTag) {
          this.jsxReadString(code2);
          return;
        }
      }
      if (code2 === 60 && this.state.canStartJSXElement && this.input.charCodeAt(this.state.pos + 1) !== 33) {
        ++this.state.pos;
        this.finishToken(143);
        return;
      }
      super.getTokenFromCode(code2);
    }
    updateContext(prevType) {
      const {
        context,
        type
      } = this.state;
      if (type === 56 && prevType === 143) {
        context.splice(-2, 2, types.j_cTag);
        this.state.canStartJSXElement = false;
      } else if (type === 143) {
        context.push(types.j_oTag);
      } else if (type === 144) {
        const out = context[context.length - 1];
        if (out === types.j_oTag && prevType === 56 || out === types.j_cTag) {
          context.pop();
          this.state.canStartJSXElement = context[context.length - 1] === types.j_expr;
        } else {
          this.setContext(types.j_expr);
          this.state.canStartJSXElement = true;
        }
      } else {
        this.state.canStartJSXElement = tokenComesBeforeExpression(type);
      }
    }
  };

  class TypeScriptScope extends Scope {
    constructor(...args) {
      super(...args);
      this.tsNames = new Map;
    }
  }

  class TypeScriptScopeHandler extends ScopeHandler {
    constructor(...args) {
      super(...args);
      this.importsStack = [];
    }
    createScope(flags) {
      this.importsStack.push(new Set);
      return new TypeScriptScope(flags);
    }
    enter(flags) {
      if (flags === 1024) {
        this.importsStack.push(new Set);
      }
      super.enter(flags);
    }
    exit() {
      const flags = super.exit();
      if (flags === 1024) {
        this.importsStack.pop();
      }
      return flags;
    }
    hasImport(name, allowShadow) {
      const len = this.importsStack.length;
      if (this.importsStack[len - 1].has(name)) {
        return true;
      }
      if (!allowShadow && len > 1) {
        for (let i = 0;i < len - 1; i++) {
          if (this.importsStack[i].has(name))
            return true;
        }
      }
      return false;
    }
    declareName(name, bindingType, loc) {
      if (bindingType & 4096) {
        if (this.hasImport(name, true)) {
          this.parser.raise(Errors.VarRedeclaration, loc, {
            identifierName: name
          });
        }
        this.importsStack[this.importsStack.length - 1].add(name);
        return;
      }
      const scope = this.currentScope();
      let type = scope.tsNames.get(name) || 0;
      if (bindingType & 1024) {
        this.maybeExportDefined(scope, name);
        scope.tsNames.set(name, type | 16);
        return;
      }
      super.declareName(name, bindingType, loc);
      if (bindingType & 2) {
        if (!(bindingType & 1)) {
          this.checkRedeclarationInScope(scope, name, bindingType, loc);
          this.maybeExportDefined(scope, name);
        }
        type = type | 1;
      }
      if (bindingType & 256) {
        type = type | 2;
      }
      if (bindingType & 512) {
        type = type | 4;
      }
      if (bindingType & 128) {
        type = type | 8;
      }
      if (type)
        scope.tsNames.set(name, type);
    }
    isRedeclaredInScope(scope, name, bindingType) {
      const type = scope.tsNames.get(name);
      if ((type & 2) > 0) {
        if (bindingType & 256) {
          const isConst = !!(bindingType & 512);
          const wasConst = (type & 4) > 0;
          return isConst !== wasConst;
        }
        return true;
      }
      if (bindingType & 128 && (type & 8) > 0) {
        if (scope.names.get(name) & 2) {
          return !!(bindingType & 1);
        } else {
          return false;
        }
      }
      if (bindingType & 2 && (type & 1) > 0) {
        return true;
      }
      return super.isRedeclaredInScope(scope, name, bindingType);
    }
    checkLocalExport(id) {
      const {
        name
      } = id;
      if (this.hasImport(name))
        return;
      const len = this.scopeStack.length;
      for (let i = len - 1;i >= 0; i--) {
        const scope = this.scopeStack[i];
        const type = scope.tsNames.get(name);
        if ((type & 1) > 0 || (type & 16) > 0) {
          return;
        }
      }
      super.checkLocalExport(id);
    }
  }

  class ProductionParameterHandler {
    constructor() {
      this.stacks = [];
    }
    enter(flags) {
      this.stacks.push(flags);
    }
    exit() {
      this.stacks.pop();
    }
    currentFlags() {
      return this.stacks[this.stacks.length - 1];
    }
    get hasAwait() {
      return (this.currentFlags() & 2) > 0;
    }
    get hasYield() {
      return (this.currentFlags() & 1) > 0;
    }
    get hasReturn() {
      return (this.currentFlags() & 4) > 0;
    }
    get hasIn() {
      return (this.currentFlags() & 8) > 0;
    }
  }
  function functionFlags(isAsync, isGenerator) {
    return (isAsync ? 2 : 0) | (isGenerator ? 1 : 0);
  }

  class BaseParser {
    constructor() {
      this.sawUnambiguousESM = false;
      this.ambiguousScriptDifferentAst = false;
    }
    sourceToOffsetPos(sourcePos) {
      return sourcePos + this.startIndex;
    }
    offsetToSourcePos(offsetPos) {
      return offsetPos - this.startIndex;
    }
    hasPlugin(pluginConfig) {
      if (typeof pluginConfig === "string") {
        return this.plugins.has(pluginConfig);
      } else {
        const [pluginName, pluginOptions] = pluginConfig;
        if (!this.hasPlugin(pluginName)) {
          return false;
        }
        const actualOptions = this.plugins.get(pluginName);
        for (const key of Object.keys(pluginOptions)) {
          if ((actualOptions == null ? undefined : actualOptions[key]) !== pluginOptions[key]) {
            return false;
          }
        }
        return true;
      }
    }
    getPluginOption(plugin, name) {
      var _this$plugins$get;
      return (_this$plugins$get = this.plugins.get(plugin)) == null ? undefined : _this$plugins$get[name];
    }
  }
  function setTrailingComments(node, comments) {
    if (node.trailingComments === undefined) {
      node.trailingComments = comments;
    } else {
      node.trailingComments.unshift(...comments);
    }
  }
  function setLeadingComments(node, comments) {
    if (node.leadingComments === undefined) {
      node.leadingComments = comments;
    } else {
      node.leadingComments.unshift(...comments);
    }
  }
  function setInnerComments(node, comments) {
    if (node.innerComments === undefined) {
      node.innerComments = comments;
    } else {
      node.innerComments.unshift(...comments);
    }
  }
  function adjustInnerComments(node, elements, commentWS) {
    let lastElement = null;
    let i = elements.length;
    while (lastElement === null && i > 0) {
      lastElement = elements[--i];
    }
    if (lastElement === null || lastElement.start > commentWS.start) {
      setInnerComments(node, commentWS.comments);
    } else {
      setTrailingComments(lastElement, commentWS.comments);
    }
  }

  class CommentsParser extends BaseParser {
    addComment(comment) {
      if (this.filename)
        comment.loc.filename = this.filename;
      const {
        commentsLen
      } = this.state;
      if (this.comments.length !== commentsLen) {
        this.comments.length = commentsLen;
      }
      this.comments.push(comment);
      this.state.commentsLen++;
    }
    processComment(node) {
      const {
        commentStack
      } = this.state;
      const commentStackLength = commentStack.length;
      if (commentStackLength === 0)
        return;
      let i = commentStackLength - 1;
      const lastCommentWS = commentStack[i];
      if (lastCommentWS.start === node.end) {
        lastCommentWS.leadingNode = node;
        i--;
      }
      const {
        start: nodeStart
      } = node;
      for (;i >= 0; i--) {
        const commentWS = commentStack[i];
        const commentEnd = commentWS.end;
        if (commentEnd > nodeStart) {
          commentWS.containingNode = node;
          this.finalizeComment(commentWS);
          commentStack.splice(i, 1);
        } else {
          if (commentEnd === nodeStart) {
            commentWS.trailingNode = node;
          }
          break;
        }
      }
    }
    finalizeComment(commentWS) {
      var _node$options;
      const {
        comments
      } = commentWS;
      if (commentWS.leadingNode !== null || commentWS.trailingNode !== null) {
        if (commentWS.leadingNode !== null) {
          setTrailingComments(commentWS.leadingNode, comments);
        }
        if (commentWS.trailingNode !== null) {
          setLeadingComments(commentWS.trailingNode, comments);
        }
      } else {
        const node = commentWS.containingNode;
        const commentStart = commentWS.start;
        if (this.input.charCodeAt(this.offsetToSourcePos(commentStart) - 1) === 44) {
          switch (node.type) {
            case "ObjectExpression":
            case "ObjectPattern":
              adjustInnerComments(node, node.properties, commentWS);
              break;
            case "CallExpression":
            case "NewExpression":
            case "OptionalCallExpression":
              adjustInnerComments(node, node.arguments, commentWS);
              break;
            case "ImportExpression":
              adjustInnerComments(node, [node.source, (_node$options = node.options) != null ? _node$options : null], commentWS);
              break;
            case "FunctionDeclaration":
            case "FunctionExpression":
            case "ArrowFunctionExpression":
            case "ObjectMethod":
            case "ClassMethod":
            case "ClassPrivateMethod":
            case "TSTypeParameterDeclaration":
              adjustInnerComments(node, node.params, commentWS);
              break;
            case "ArrayExpression":
            case "ArrayPattern":
              adjustInnerComments(node, node.elements, commentWS);
              break;
            case "ExportNamedDeclaration":
            case "ImportDeclaration":
              adjustInnerComments(node, node.specifiers, commentWS);
              break;
            case "TSEnumDeclaration":
              adjustInnerComments(node, node.members, commentWS);
              break;
            case "TSEnumBody":
              adjustInnerComments(node, node.members, commentWS);
              break;
            case "TSInterfaceBody":
              adjustInnerComments(node, node.body, commentWS);
              break;
            default: {
              if (node.type === "RecordExpression") {
                adjustInnerComments(node, node.properties, commentWS);
                break;
              }
              if (node.type === "TupleExpression") {
                adjustInnerComments(node, node.elements, commentWS);
                break;
              }
              setInnerComments(node, comments);
            }
          }
        } else {
          setInnerComments(node, comments);
        }
      }
    }
    finalizeRemainingComments() {
      const {
        commentStack
      } = this.state;
      for (let i = commentStack.length - 1;i >= 0; i--) {
        this.finalizeComment(commentStack[i]);
      }
      this.state.commentStack = [];
    }
    resetPreviousNodeTrailingComments(node) {
      const {
        commentStack
      } = this.state;
      const {
        length
      } = commentStack;
      if (length === 0)
        return;
      const commentWS = commentStack[length - 1];
      if (commentWS.leadingNode === node) {
        commentWS.leadingNode = null;
      }
    }
    takeSurroundingComments(node, start, end) {
      const {
        commentStack
      } = this.state;
      const commentStackLength = commentStack.length;
      if (commentStackLength === 0)
        return;
      let i = commentStackLength - 1;
      for (;i >= 0; i--) {
        const commentWS = commentStack[i];
        const commentEnd = commentWS.end;
        const commentStart = commentWS.start;
        if (commentStart === end) {
          commentWS.leadingNode = node;
        } else if (commentEnd === start) {
          commentWS.trailingNode = node;
        } else if (commentEnd < start) {
          break;
        }
      }
    }
  }

  class State {
    constructor() {
      this.flags = 1024;
      this.startIndex = undefined;
      this.curLine = undefined;
      this.lineStart = undefined;
      this.startLoc = undefined;
      this.endLoc = undefined;
      this.errors = [];
      this.potentialArrowAt = -1;
      this.noArrowAt = [];
      this.noArrowParamsConversionAt = [];
      this.topicContext = {
        maxNumOfResolvableTopics: 0,
        maxTopicIndex: null
      };
      this.labels = [];
      this.commentsLen = 0;
      this.commentStack = [];
      this.pos = 0;
      this.type = 140;
      this.value = null;
      this.start = 0;
      this.end = 0;
      this.lastTokEndLoc = null;
      this.lastTokStartLoc = null;
      this.context = [types.brace];
      this.firstInvalidTemplateEscapePos = null;
      this.strictErrors = new Map;
      this.tokensLength = 0;
    }
    get strict() {
      return (this.flags & 1) > 0;
    }
    set strict(v) {
      if (v)
        this.flags |= 1;
      else
        this.flags &= -2;
    }
    init({
      strictMode,
      sourceType,
      startIndex,
      startLine,
      startColumn
    }) {
      this.strict = strictMode === false ? false : strictMode === true ? true : sourceType === "module";
      this.startIndex = startIndex;
      this.curLine = startLine;
      this.lineStart = -startColumn;
      this.startLoc = this.endLoc = new Position(startLine, startColumn, startIndex);
    }
    get maybeInArrowParameters() {
      return (this.flags & 2) > 0;
    }
    set maybeInArrowParameters(v) {
      if (v)
        this.flags |= 2;
      else
        this.flags &= -3;
    }
    get inType() {
      return (this.flags & 4) > 0;
    }
    set inType(v) {
      if (v)
        this.flags |= 4;
      else
        this.flags &= -5;
    }
    get noAnonFunctionType() {
      return (this.flags & 8) > 0;
    }
    set noAnonFunctionType(v) {
      if (v)
        this.flags |= 8;
      else
        this.flags &= -9;
    }
    get hasFlowComment() {
      return (this.flags & 16) > 0;
    }
    set hasFlowComment(v) {
      if (v)
        this.flags |= 16;
      else
        this.flags &= -17;
    }
    get isAmbientContext() {
      return (this.flags & 32) > 0;
    }
    set isAmbientContext(v) {
      if (v)
        this.flags |= 32;
      else
        this.flags &= -33;
    }
    get inAbstractClass() {
      return (this.flags & 64) > 0;
    }
    set inAbstractClass(v) {
      if (v)
        this.flags |= 64;
      else
        this.flags &= -65;
    }
    get inDisallowConditionalTypesContext() {
      return (this.flags & 128) > 0;
    }
    set inDisallowConditionalTypesContext(v) {
      if (v)
        this.flags |= 128;
      else
        this.flags &= -129;
    }
    get soloAwait() {
      return (this.flags & 256) > 0;
    }
    set soloAwait(v) {
      if (v)
        this.flags |= 256;
      else
        this.flags &= -257;
    }
    get inFSharpPipelineDirectBody() {
      return (this.flags & 512) > 0;
    }
    set inFSharpPipelineDirectBody(v) {
      if (v)
        this.flags |= 512;
      else
        this.flags &= -513;
    }
    get canStartJSXElement() {
      return (this.flags & 1024) > 0;
    }
    set canStartJSXElement(v) {
      if (v)
        this.flags |= 1024;
      else
        this.flags &= -1025;
    }
    get containsEsc() {
      return (this.flags & 2048) > 0;
    }
    set containsEsc(v) {
      if (v)
        this.flags |= 2048;
      else
        this.flags &= -2049;
    }
    get hasTopLevelAwait() {
      return (this.flags & 4096) > 0;
    }
    set hasTopLevelAwait(v) {
      if (v)
        this.flags |= 4096;
      else
        this.flags &= -4097;
    }
    curPosition() {
      return new Position(this.curLine, this.pos - this.lineStart, this.pos + this.startIndex);
    }
    clone() {
      const state = new State;
      state.flags = this.flags;
      state.startIndex = this.startIndex;
      state.curLine = this.curLine;
      state.lineStart = this.lineStart;
      state.startLoc = this.startLoc;
      state.endLoc = this.endLoc;
      state.errors = this.errors.slice();
      state.potentialArrowAt = this.potentialArrowAt;
      state.noArrowAt = this.noArrowAt.slice();
      state.noArrowParamsConversionAt = this.noArrowParamsConversionAt.slice();
      state.topicContext = this.topicContext;
      state.labels = this.labels.slice();
      state.commentsLen = this.commentsLen;
      state.commentStack = this.commentStack.slice();
      state.pos = this.pos;
      state.type = this.type;
      state.value = this.value;
      state.start = this.start;
      state.end = this.end;
      state.lastTokEndLoc = this.lastTokEndLoc;
      state.lastTokStartLoc = this.lastTokStartLoc;
      state.context = this.context.slice();
      state.firstInvalidTemplateEscapePos = this.firstInvalidTemplateEscapePos;
      state.strictErrors = this.strictErrors;
      state.tokensLength = this.tokensLength;
      return state;
    }
  }
  var _isDigit = function isDigit(code2) {
    return code2 >= 48 && code2 <= 57;
  };
  var forbiddenNumericSeparatorSiblings = {
    decBinOct: new Set([46, 66, 69, 79, 95, 98, 101, 111]),
    hex: new Set([46, 88, 95, 120])
  };
  var isAllowedNumericSeparatorSibling = {
    bin: (ch) => ch === 48 || ch === 49,
    oct: (ch) => ch >= 48 && ch <= 55,
    dec: (ch) => ch >= 48 && ch <= 57,
    hex: (ch) => ch >= 48 && ch <= 57 || ch >= 65 && ch <= 70 || ch >= 97 && ch <= 102
  };
  function readStringContents(type, input, pos, lineStart, curLine, errors) {
    const initialPos = pos;
    const initialLineStart = lineStart;
    const initialCurLine = curLine;
    let out = "";
    let firstInvalidLoc = null;
    let chunkStart = pos;
    const {
      length
    } = input;
    for (;; ) {
      if (pos >= length) {
        errors.unterminated(initialPos, initialLineStart, initialCurLine);
        out += input.slice(chunkStart, pos);
        break;
      }
      const ch = input.charCodeAt(pos);
      if (isStringEnd(type, ch, input, pos)) {
        out += input.slice(chunkStart, pos);
        break;
      }
      if (ch === 92) {
        out += input.slice(chunkStart, pos);
        const res = readEscapedChar(input, pos, lineStart, curLine, type === "template", errors);
        if (res.ch === null && !firstInvalidLoc) {
          firstInvalidLoc = {
            pos,
            lineStart,
            curLine
          };
        } else {
          out += res.ch;
        }
        ({
          pos,
          lineStart,
          curLine
        } = res);
        chunkStart = pos;
      } else if (ch === 8232 || ch === 8233) {
        ++pos;
        ++curLine;
        lineStart = pos;
      } else if (ch === 10 || ch === 13) {
        if (type === "template") {
          out += input.slice(chunkStart, pos) + `
`;
          ++pos;
          if (ch === 13 && input.charCodeAt(pos) === 10) {
            ++pos;
          }
          ++curLine;
          chunkStart = lineStart = pos;
        } else {
          errors.unterminated(initialPos, initialLineStart, initialCurLine);
        }
      } else {
        ++pos;
      }
    }
    return {
      pos,
      str: out,
      firstInvalidLoc,
      lineStart,
      curLine,
      containsInvalid: !!firstInvalidLoc
    };
  }
  function isStringEnd(type, ch, input, pos) {
    if (type === "template") {
      return ch === 96 || ch === 36 && input.charCodeAt(pos + 1) === 123;
    }
    return ch === (type === "double" ? 34 : 39);
  }
  function readEscapedChar(input, pos, lineStart, curLine, inTemplate, errors) {
    const throwOnInvalid = !inTemplate;
    pos++;
    const res = (ch2) => ({
      pos,
      ch: ch2,
      lineStart,
      curLine
    });
    const ch = input.charCodeAt(pos++);
    switch (ch) {
      case 110:
        return res(`
`);
      case 114:
        return res("\r");
      case 120: {
        let code2;
        ({
          code: code2,
          pos
        } = readHexChar(input, pos, lineStart, curLine, 2, false, throwOnInvalid, errors));
        return res(code2 === null ? null : String.fromCharCode(code2));
      }
      case 117: {
        let code2;
        ({
          code: code2,
          pos
        } = readCodePoint(input, pos, lineStart, curLine, throwOnInvalid, errors));
        return res(code2 === null ? null : String.fromCodePoint(code2));
      }
      case 116:
        return res("\t");
      case 98:
        return res("\b");
      case 118:
        return res("\v");
      case 102:
        return res("\f");
      case 13:
        if (input.charCodeAt(pos) === 10) {
          ++pos;
        }
      case 10:
        lineStart = pos;
        ++curLine;
      case 8232:
      case 8233:
        return res("");
      case 56:
      case 57:
        if (inTemplate) {
          return res(null);
        } else {
          errors.strictNumericEscape(pos - 1, lineStart, curLine);
        }
      default:
        if (ch >= 48 && ch <= 55) {
          const startPos = pos - 1;
          const match = /^[0-7]+/.exec(input.slice(startPos, pos + 2));
          let octalStr = match[0];
          let octal = parseInt(octalStr, 8);
          if (octal > 255) {
            octalStr = octalStr.slice(0, -1);
            octal = parseInt(octalStr, 8);
          }
          pos += octalStr.length - 1;
          const next = input.charCodeAt(pos);
          if (octalStr !== "0" || next === 56 || next === 57) {
            if (inTemplate) {
              return res(null);
            } else {
              errors.strictNumericEscape(startPos, lineStart, curLine);
            }
          }
          return res(String.fromCharCode(octal));
        }
        return res(String.fromCharCode(ch));
    }
  }
  function readHexChar(input, pos, lineStart, curLine, len, forceLen, throwOnInvalid, errors) {
    const initialPos = pos;
    let n;
    ({
      n,
      pos
    } = readInt(input, pos, lineStart, curLine, 16, len, forceLen, false, errors, !throwOnInvalid));
    if (n === null) {
      if (throwOnInvalid) {
        errors.invalidEscapeSequence(initialPos, lineStart, curLine);
      } else {
        pos = initialPos - 1;
      }
    }
    return {
      code: n,
      pos
    };
  }
  function readInt(input, pos, lineStart, curLine, radix, len, forceLen, allowNumSeparator, errors, bailOnError) {
    const start = pos;
    const forbiddenSiblings = radix === 16 ? forbiddenNumericSeparatorSiblings.hex : forbiddenNumericSeparatorSiblings.decBinOct;
    const isAllowedSibling = radix === 16 ? isAllowedNumericSeparatorSibling.hex : radix === 10 ? isAllowedNumericSeparatorSibling.dec : radix === 8 ? isAllowedNumericSeparatorSibling.oct : isAllowedNumericSeparatorSibling.bin;
    let invalid = false;
    let total = 0;
    for (let i = 0, e = len == null ? Infinity : len;i < e; ++i) {
      const code2 = input.charCodeAt(pos);
      let val;
      if (code2 === 95 && allowNumSeparator !== "bail") {
        const prev = input.charCodeAt(pos - 1);
        const next = input.charCodeAt(pos + 1);
        if (!allowNumSeparator) {
          if (bailOnError)
            return {
              n: null,
              pos
            };
          errors.numericSeparatorInEscapeSequence(pos, lineStart, curLine);
        } else if (Number.isNaN(next) || !isAllowedSibling(next) || forbiddenSiblings.has(prev) || forbiddenSiblings.has(next)) {
          if (bailOnError)
            return {
              n: null,
              pos
            };
          errors.unexpectedNumericSeparator(pos, lineStart, curLine);
        }
        ++pos;
        continue;
      }
      if (code2 >= 97) {
        val = code2 - 97 + 10;
      } else if (code2 >= 65) {
        val = code2 - 65 + 10;
      } else if (_isDigit(code2)) {
        val = code2 - 48;
      } else {
        val = Infinity;
      }
      if (val >= radix) {
        if (val <= 9 && bailOnError) {
          return {
            n: null,
            pos
          };
        } else if (val <= 9 && errors.invalidDigit(pos, lineStart, curLine, radix)) {
          val = 0;
        } else if (forceLen) {
          val = 0;
          invalid = true;
        } else {
          break;
        }
      }
      ++pos;
      total = total * radix + val;
    }
    if (pos === start || len != null && pos - start !== len || invalid) {
      return {
        n: null,
        pos
      };
    }
    return {
      n: total,
      pos
    };
  }
  function readCodePoint(input, pos, lineStart, curLine, throwOnInvalid, errors) {
    const ch = input.charCodeAt(pos);
    let code2;
    if (ch === 123) {
      ++pos;
      ({
        code: code2,
        pos
      } = readHexChar(input, pos, lineStart, curLine, input.indexOf("}", pos) - pos, true, throwOnInvalid, errors));
      ++pos;
      if (code2 !== null && code2 > 1114111) {
        if (throwOnInvalid) {
          errors.invalidCodePoint(pos, lineStart, curLine);
        } else {
          return {
            code: null,
            pos
          };
        }
      }
    } else {
      ({
        code: code2,
        pos
      } = readHexChar(input, pos, lineStart, curLine, 4, false, throwOnInvalid, errors));
    }
    return {
      code: code2,
      pos
    };
  }
  function buildPosition(pos, lineStart, curLine) {
    return new Position(curLine, pos - lineStart, pos);
  }
  var VALID_REGEX_FLAGS = new Set([103, 109, 115, 105, 121, 117, 100, 118]);

  class Token {
    constructor(state) {
      const startIndex = state.startIndex || 0;
      this.type = state.type;
      this.value = state.value;
      this.start = startIndex + state.start;
      this.end = startIndex + state.end;
      this.loc = new SourceLocation(state.startLoc, state.endLoc);
    }
  }

  class Tokenizer extends CommentsParser {
    constructor(options, input) {
      super();
      this.isLookahead = undefined;
      this.tokens = [];
      this.errorHandlers_readInt = {
        invalidDigit: (pos, lineStart, curLine, radix) => {
          if (!(this.optionFlags & 2048))
            return false;
          this.raise(Errors.InvalidDigit, buildPosition(pos, lineStart, curLine), {
            radix
          });
          return true;
        },
        numericSeparatorInEscapeSequence: this.errorBuilder(Errors.NumericSeparatorInEscapeSequence),
        unexpectedNumericSeparator: this.errorBuilder(Errors.UnexpectedNumericSeparator)
      };
      this.errorHandlers_readCodePoint = Object.assign({}, this.errorHandlers_readInt, {
        invalidEscapeSequence: this.errorBuilder(Errors.InvalidEscapeSequence),
        invalidCodePoint: this.errorBuilder(Errors.InvalidCodePoint)
      });
      this.errorHandlers_readStringContents_string = Object.assign({}, this.errorHandlers_readCodePoint, {
        strictNumericEscape: (pos, lineStart, curLine) => {
          this.recordStrictModeErrors(Errors.StrictNumericEscape, buildPosition(pos, lineStart, curLine));
        },
        unterminated: (pos, lineStart, curLine) => {
          throw this.raise(Errors.UnterminatedString, buildPosition(pos - 1, lineStart, curLine));
        }
      });
      this.errorHandlers_readStringContents_template = Object.assign({}, this.errorHandlers_readCodePoint, {
        strictNumericEscape: this.errorBuilder(Errors.StrictNumericEscape),
        unterminated: (pos, lineStart, curLine) => {
          throw this.raise(Errors.UnterminatedTemplate, buildPosition(pos, lineStart, curLine));
        }
      });
      this.state = new State;
      this.state.init(options);
      this.input = input;
      this.length = input.length;
      this.comments = [];
      this.isLookahead = false;
    }
    pushToken(token) {
      this.tokens.length = this.state.tokensLength;
      this.tokens.push(token);
      ++this.state.tokensLength;
    }
    next() {
      this.checkKeywordEscapes();
      if (this.optionFlags & 256) {
        this.pushToken(new Token(this.state));
      }
      this.state.lastTokEndLoc = this.state.endLoc;
      this.state.lastTokStartLoc = this.state.startLoc;
      this.nextToken();
    }
    eat(type) {
      if (this.match(type)) {
        this.next();
        return true;
      } else {
        return false;
      }
    }
    match(type) {
      return this.state.type === type;
    }
    createLookaheadState(state) {
      return {
        pos: state.pos,
        value: null,
        type: state.type,
        start: state.start,
        end: state.end,
        context: [this.curContext()],
        inType: state.inType,
        startLoc: state.startLoc,
        lastTokEndLoc: state.lastTokEndLoc,
        curLine: state.curLine,
        lineStart: state.lineStart,
        curPosition: state.curPosition
      };
    }
    lookahead() {
      const old = this.state;
      this.state = this.createLookaheadState(old);
      this.isLookahead = true;
      this.nextToken();
      this.isLookahead = false;
      const curr = this.state;
      this.state = old;
      return curr;
    }
    nextTokenStart() {
      return this.nextTokenStartSince(this.state.pos);
    }
    nextTokenStartSince(pos) {
      skipWhiteSpace.lastIndex = pos;
      return skipWhiteSpace.test(this.input) ? skipWhiteSpace.lastIndex : pos;
    }
    lookaheadCharCode() {
      return this.lookaheadCharCodeSince(this.state.pos);
    }
    lookaheadCharCodeSince(pos) {
      return this.input.charCodeAt(this.nextTokenStartSince(pos));
    }
    nextTokenInLineStart() {
      return this.nextTokenInLineStartSince(this.state.pos);
    }
    nextTokenInLineStartSince(pos) {
      skipWhiteSpaceInLine.lastIndex = pos;
      return skipWhiteSpaceInLine.test(this.input) ? skipWhiteSpaceInLine.lastIndex : pos;
    }
    lookaheadInLineCharCode() {
      return this.input.charCodeAt(this.nextTokenInLineStart());
    }
    codePointAtPos(pos) {
      let cp = this.input.charCodeAt(pos);
      if ((cp & 64512) === 55296 && ++pos < this.input.length) {
        const trail = this.input.charCodeAt(pos);
        if ((trail & 64512) === 56320) {
          cp = 65536 + ((cp & 1023) << 10) + (trail & 1023);
        }
      }
      return cp;
    }
    setStrict(strict) {
      this.state.strict = strict;
      if (strict) {
        this.state.strictErrors.forEach(([toParseError, at]) => this.raise(toParseError, at));
        this.state.strictErrors.clear();
      }
    }
    curContext() {
      return this.state.context[this.state.context.length - 1];
    }
    nextToken() {
      this.skipSpace();
      this.state.start = this.state.pos;
      if (!this.isLookahead)
        this.state.startLoc = this.state.curPosition();
      if (this.state.pos >= this.length) {
        this.finishToken(140);
        return;
      }
      this.getTokenFromCode(this.codePointAtPos(this.state.pos));
    }
    skipBlockComment(commentEnd) {
      let startLoc;
      if (!this.isLookahead)
        startLoc = this.state.curPosition();
      const start = this.state.pos;
      const end = this.input.indexOf(commentEnd, start + 2);
      if (end === -1) {
        throw this.raise(Errors.UnterminatedComment, this.state.curPosition());
      }
      this.state.pos = end + commentEnd.length;
      lineBreakG.lastIndex = start + 2;
      while (lineBreakG.test(this.input) && lineBreakG.lastIndex <= end) {
        ++this.state.curLine;
        this.state.lineStart = lineBreakG.lastIndex;
      }
      if (this.isLookahead)
        return;
      const comment = {
        type: "CommentBlock",
        value: this.input.slice(start + 2, end),
        start: this.sourceToOffsetPos(start),
        end: this.sourceToOffsetPos(end + commentEnd.length),
        loc: new SourceLocation(startLoc, this.state.curPosition())
      };
      if (this.optionFlags & 256)
        this.pushToken(comment);
      return comment;
    }
    skipLineComment(startSkip) {
      const start = this.state.pos;
      let startLoc;
      if (!this.isLookahead)
        startLoc = this.state.curPosition();
      let ch = this.input.charCodeAt(this.state.pos += startSkip);
      if (this.state.pos < this.length) {
        while (!isNewLine(ch) && ++this.state.pos < this.length) {
          ch = this.input.charCodeAt(this.state.pos);
        }
      }
      if (this.isLookahead)
        return;
      const end = this.state.pos;
      const value = this.input.slice(start + startSkip, end);
      const comment = {
        type: "CommentLine",
        value,
        start: this.sourceToOffsetPos(start),
        end: this.sourceToOffsetPos(end),
        loc: new SourceLocation(startLoc, this.state.curPosition())
      };
      if (this.optionFlags & 256)
        this.pushToken(comment);
      return comment;
    }
    skipSpace() {
      const spaceStart = this.state.pos;
      const comments = this.optionFlags & 4096 ? [] : null;
      loop:
        while (this.state.pos < this.length) {
          const ch = this.input.charCodeAt(this.state.pos);
          switch (ch) {
            case 32:
            case 160:
            case 9:
              ++this.state.pos;
              break;
            case 13:
              if (this.input.charCodeAt(this.state.pos + 1) === 10) {
                ++this.state.pos;
              }
            case 10:
            case 8232:
            case 8233:
              ++this.state.pos;
              ++this.state.curLine;
              this.state.lineStart = this.state.pos;
              break;
            case 47:
              switch (this.input.charCodeAt(this.state.pos + 1)) {
                case 42: {
                  const comment = this.skipBlockComment("*/");
                  if (comment !== undefined) {
                    this.addComment(comment);
                    comments == null || comments.push(comment);
                  }
                  break;
                }
                case 47: {
                  const comment = this.skipLineComment(2);
                  if (comment !== undefined) {
                    this.addComment(comment);
                    comments == null || comments.push(comment);
                  }
                  break;
                }
                default:
                  break loop;
              }
              break;
            default:
              if (isWhitespace(ch)) {
                ++this.state.pos;
              } else if (ch === 45 && !this.inModule && this.optionFlags & 8192) {
                const pos = this.state.pos;
                if (this.input.charCodeAt(pos + 1) === 45 && this.input.charCodeAt(pos + 2) === 62 && (spaceStart === 0 || this.state.lineStart > spaceStart)) {
                  const comment = this.skipLineComment(3);
                  if (comment !== undefined) {
                    this.addComment(comment);
                    comments == null || comments.push(comment);
                  }
                } else {
                  break loop;
                }
              } else if (ch === 60 && !this.inModule && this.optionFlags & 8192) {
                const pos = this.state.pos;
                if (this.input.charCodeAt(pos + 1) === 33 && this.input.charCodeAt(pos + 2) === 45 && this.input.charCodeAt(pos + 3) === 45) {
                  const comment = this.skipLineComment(4);
                  if (comment !== undefined) {
                    this.addComment(comment);
                    comments == null || comments.push(comment);
                  }
                } else {
                  break loop;
                }
              } else {
                break loop;
              }
          }
        }
      if ((comments == null ? undefined : comments.length) > 0) {
        const end = this.state.pos;
        const commentWhitespace = {
          start: this.sourceToOffsetPos(spaceStart),
          end: this.sourceToOffsetPos(end),
          comments,
          leadingNode: null,
          trailingNode: null,
          containingNode: null
        };
        this.state.commentStack.push(commentWhitespace);
      }
    }
    finishToken(type, val) {
      this.state.end = this.state.pos;
      this.state.endLoc = this.state.curPosition();
      const prevType = this.state.type;
      this.state.type = type;
      this.state.value = val;
      if (!this.isLookahead) {
        this.updateContext(prevType);
      }
    }
    replaceToken(type) {
      this.state.type = type;
      this.updateContext();
    }
    readToken_numberSign() {
      if (this.state.pos === 0 && this.readToken_interpreter()) {
        return;
      }
      const nextPos = this.state.pos + 1;
      const next = this.codePointAtPos(nextPos);
      if (next >= 48 && next <= 57) {
        throw this.raise(Errors.UnexpectedDigitAfterHash, this.state.curPosition());
      }
      if (next === 123 || next === 91 && this.hasPlugin("recordAndTuple")) {
        this.expectPlugin("recordAndTuple");
        if (this.getPluginOption("recordAndTuple", "syntaxType") === "bar") {
          throw this.raise(next === 123 ? Errors.RecordExpressionHashIncorrectStartSyntaxType : Errors.TupleExpressionHashIncorrectStartSyntaxType, this.state.curPosition());
        }
        this.state.pos += 2;
        if (next === 123) {
          this.finishToken(7);
        } else {
          this.finishToken(1);
        }
      } else if (isIdentifierStart(next)) {
        ++this.state.pos;
        this.finishToken(139, this.readWord1(next));
      } else if (next === 92) {
        ++this.state.pos;
        this.finishToken(139, this.readWord1());
      } else {
        this.finishOp(27, 1);
      }
    }
    readToken_dot() {
      const next = this.input.charCodeAt(this.state.pos + 1);
      if (next >= 48 && next <= 57) {
        this.readNumber(true);
        return;
      }
      if (next === 46 && this.input.charCodeAt(this.state.pos + 2) === 46) {
        this.state.pos += 3;
        this.finishToken(21);
      } else {
        ++this.state.pos;
        this.finishToken(16);
      }
    }
    readToken_slash() {
      const next = this.input.charCodeAt(this.state.pos + 1);
      if (next === 61) {
        this.finishOp(31, 2);
      } else {
        this.finishOp(56, 1);
      }
    }
    readToken_interpreter() {
      if (this.state.pos !== 0 || this.length < 2)
        return false;
      let ch = this.input.charCodeAt(this.state.pos + 1);
      if (ch !== 33)
        return false;
      const start = this.state.pos;
      this.state.pos += 1;
      while (!isNewLine(ch) && ++this.state.pos < this.length) {
        ch = this.input.charCodeAt(this.state.pos);
      }
      const value = this.input.slice(start + 2, this.state.pos);
      this.finishToken(28, value);
      return true;
    }
    readToken_mult_modulo(code2) {
      let type = code2 === 42 ? 55 : 54;
      let width = 1;
      let next = this.input.charCodeAt(this.state.pos + 1);
      if (code2 === 42 && next === 42) {
        width++;
        next = this.input.charCodeAt(this.state.pos + 2);
        type = 57;
      }
      if (next === 61 && !this.state.inType) {
        width++;
        type = code2 === 37 ? 33 : 30;
      }
      this.finishOp(type, width);
    }
    readToken_pipe_amp(code2) {
      const next = this.input.charCodeAt(this.state.pos + 1);
      if (next === code2) {
        if (this.input.charCodeAt(this.state.pos + 2) === 61) {
          this.finishOp(30, 3);
        } else {
          this.finishOp(code2 === 124 ? 41 : 42, 2);
        }
        return;
      }
      if (code2 === 124) {
        if (next === 62) {
          this.finishOp(39, 2);
          return;
        }
        if (this.hasPlugin("recordAndTuple") && next === 125) {
          if (this.getPluginOption("recordAndTuple", "syntaxType") !== "bar") {
            throw this.raise(Errors.RecordExpressionBarIncorrectEndSyntaxType, this.state.curPosition());
          }
          this.state.pos += 2;
          this.finishToken(9);
          return;
        }
        if (this.hasPlugin("recordAndTuple") && next === 93) {
          if (this.getPluginOption("recordAndTuple", "syntaxType") !== "bar") {
            throw this.raise(Errors.TupleExpressionBarIncorrectEndSyntaxType, this.state.curPosition());
          }
          this.state.pos += 2;
          this.finishToken(4);
          return;
        }
      }
      if (next === 61) {
        this.finishOp(30, 2);
        return;
      }
      this.finishOp(code2 === 124 ? 43 : 45, 1);
    }
    readToken_caret() {
      const next = this.input.charCodeAt(this.state.pos + 1);
      if (next === 61 && !this.state.inType) {
        this.finishOp(32, 2);
      } else if (next === 94 && this.hasPlugin(["pipelineOperator", {
        proposal: "hack",
        topicToken: "^^"
      }])) {
        this.finishOp(37, 2);
        const lookaheadCh = this.input.codePointAt(this.state.pos);
        if (lookaheadCh === 94) {
          this.unexpected();
        }
      } else {
        this.finishOp(44, 1);
      }
    }
    readToken_atSign() {
      const next = this.input.charCodeAt(this.state.pos + 1);
      if (next === 64 && this.hasPlugin(["pipelineOperator", {
        proposal: "hack",
        topicToken: "@@"
      }])) {
        this.finishOp(38, 2);
      } else {
        this.finishOp(26, 1);
      }
    }
    readToken_plus_min(code2) {
      const next = this.input.charCodeAt(this.state.pos + 1);
      if (next === code2) {
        this.finishOp(34, 2);
        return;
      }
      if (next === 61) {
        this.finishOp(30, 2);
      } else {
        this.finishOp(53, 1);
      }
    }
    readToken_lt() {
      const {
        pos
      } = this.state;
      const next = this.input.charCodeAt(pos + 1);
      if (next === 60) {
        if (this.input.charCodeAt(pos + 2) === 61) {
          this.finishOp(30, 3);
          return;
        }
        this.finishOp(51, 2);
        return;
      }
      if (next === 61) {
        this.finishOp(49, 2);
        return;
      }
      this.finishOp(47, 1);
    }
    readToken_gt() {
      const {
        pos
      } = this.state;
      const next = this.input.charCodeAt(pos + 1);
      if (next === 62) {
        const size = this.input.charCodeAt(pos + 2) === 62 ? 3 : 2;
        if (this.input.charCodeAt(pos + size) === 61) {
          this.finishOp(30, size + 1);
          return;
        }
        this.finishOp(52, size);
        return;
      }
      if (next === 61) {
        this.finishOp(49, 2);
        return;
      }
      this.finishOp(48, 1);
    }
    readToken_eq_excl(code2) {
      const next = this.input.charCodeAt(this.state.pos + 1);
      if (next === 61) {
        this.finishOp(46, this.input.charCodeAt(this.state.pos + 2) === 61 ? 3 : 2);
        return;
      }
      if (code2 === 61 && next === 62) {
        this.state.pos += 2;
        this.finishToken(19);
        return;
      }
      this.finishOp(code2 === 61 ? 29 : 35, 1);
    }
    readToken_question() {
      const next = this.input.charCodeAt(this.state.pos + 1);
      const next2 = this.input.charCodeAt(this.state.pos + 2);
      if (next === 63) {
        if (next2 === 61) {
          this.finishOp(30, 3);
        } else {
          this.finishOp(40, 2);
        }
      } else if (next === 46 && !(next2 >= 48 && next2 <= 57)) {
        this.state.pos += 2;
        this.finishToken(18);
      } else {
        ++this.state.pos;
        this.finishToken(17);
      }
    }
    getTokenFromCode(code2) {
      switch (code2) {
        case 46:
          this.readToken_dot();
          return;
        case 40:
          ++this.state.pos;
          this.finishToken(10);
          return;
        case 41:
          ++this.state.pos;
          this.finishToken(11);
          return;
        case 59:
          ++this.state.pos;
          this.finishToken(13);
          return;
        case 44:
          ++this.state.pos;
          this.finishToken(12);
          return;
        case 91:
          if (this.hasPlugin("recordAndTuple") && this.input.charCodeAt(this.state.pos + 1) === 124) {
            if (this.getPluginOption("recordAndTuple", "syntaxType") !== "bar") {
              throw this.raise(Errors.TupleExpressionBarIncorrectStartSyntaxType, this.state.curPosition());
            }
            this.state.pos += 2;
            this.finishToken(2);
          } else {
            ++this.state.pos;
            this.finishToken(0);
          }
          return;
        case 93:
          ++this.state.pos;
          this.finishToken(3);
          return;
        case 123:
          if (this.hasPlugin("recordAndTuple") && this.input.charCodeAt(this.state.pos + 1) === 124) {
            if (this.getPluginOption("recordAndTuple", "syntaxType") !== "bar") {
              throw this.raise(Errors.RecordExpressionBarIncorrectStartSyntaxType, this.state.curPosition());
            }
            this.state.pos += 2;
            this.finishToken(6);
          } else {
            ++this.state.pos;
            this.finishToken(5);
          }
          return;
        case 125:
          ++this.state.pos;
          this.finishToken(8);
          return;
        case 58:
          if (this.hasPlugin("functionBind") && this.input.charCodeAt(this.state.pos + 1) === 58) {
            this.finishOp(15, 2);
          } else {
            ++this.state.pos;
            this.finishToken(14);
          }
          return;
        case 63:
          this.readToken_question();
          return;
        case 96:
          this.readTemplateToken();
          return;
        case 48: {
          const next = this.input.charCodeAt(this.state.pos + 1);
          if (next === 120 || next === 88) {
            this.readRadixNumber(16);
            return;
          }
          if (next === 111 || next === 79) {
            this.readRadixNumber(8);
            return;
          }
          if (next === 98 || next === 66) {
            this.readRadixNumber(2);
            return;
          }
        }
        case 49:
        case 50:
        case 51:
        case 52:
        case 53:
        case 54:
        case 55:
        case 56:
        case 57:
          this.readNumber(false);
          return;
        case 34:
        case 39:
          this.readString(code2);
          return;
        case 47:
          this.readToken_slash();
          return;
        case 37:
        case 42:
          this.readToken_mult_modulo(code2);
          return;
        case 124:
        case 38:
          this.readToken_pipe_amp(code2);
          return;
        case 94:
          this.readToken_caret();
          return;
        case 43:
        case 45:
          this.readToken_plus_min(code2);
          return;
        case 60:
          this.readToken_lt();
          return;
        case 62:
          this.readToken_gt();
          return;
        case 61:
        case 33:
          this.readToken_eq_excl(code2);
          return;
        case 126:
          this.finishOp(36, 1);
          return;
        case 64:
          this.readToken_atSign();
          return;
        case 35:
          this.readToken_numberSign();
          return;
        case 92:
          this.readWord();
          return;
        default:
          if (isIdentifierStart(code2)) {
            this.readWord(code2);
            return;
          }
      }
      throw this.raise(Errors.InvalidOrUnexpectedToken, this.state.curPosition(), {
        unexpected: String.fromCodePoint(code2)
      });
    }
    finishOp(type, size) {
      const str = this.input.slice(this.state.pos, this.state.pos + size);
      this.state.pos += size;
      this.finishToken(type, str);
    }
    readRegexp() {
      const startLoc = this.state.startLoc;
      const start = this.state.start + 1;
      let escaped, inClass;
      let {
        pos
      } = this.state;
      for (;; ++pos) {
        if (pos >= this.length) {
          throw this.raise(Errors.UnterminatedRegExp, createPositionWithColumnOffset(startLoc, 1));
        }
        const ch = this.input.charCodeAt(pos);
        if (isNewLine(ch)) {
          throw this.raise(Errors.UnterminatedRegExp, createPositionWithColumnOffset(startLoc, 1));
        }
        if (escaped) {
          escaped = false;
        } else {
          if (ch === 91) {
            inClass = true;
          } else if (ch === 93 && inClass) {
            inClass = false;
          } else if (ch === 47 && !inClass) {
            break;
          }
          escaped = ch === 92;
        }
      }
      const content = this.input.slice(start, pos);
      ++pos;
      let mods = "";
      const nextPos = () => createPositionWithColumnOffset(startLoc, pos + 2 - start);
      while (pos < this.length) {
        const cp = this.codePointAtPos(pos);
        const char = String.fromCharCode(cp);
        if (VALID_REGEX_FLAGS.has(cp)) {
          if (cp === 118) {
            if (mods.includes("u")) {
              this.raise(Errors.IncompatibleRegExpUVFlags, nextPos());
            }
          } else if (cp === 117) {
            if (mods.includes("v")) {
              this.raise(Errors.IncompatibleRegExpUVFlags, nextPos());
            }
          }
          if (mods.includes(char)) {
            this.raise(Errors.DuplicateRegExpFlags, nextPos());
          }
        } else if (isIdentifierChar(cp) || cp === 92) {
          this.raise(Errors.MalformedRegExpFlags, nextPos());
        } else {
          break;
        }
        ++pos;
        mods += char;
      }
      this.state.pos = pos;
      this.finishToken(138, {
        pattern: content,
        flags: mods
      });
    }
    readInt(radix, len, forceLen = false, allowNumSeparator = true) {
      const {
        n,
        pos
      } = readInt(this.input, this.state.pos, this.state.lineStart, this.state.curLine, radix, len, forceLen, allowNumSeparator, this.errorHandlers_readInt, false);
      this.state.pos = pos;
      return n;
    }
    readRadixNumber(radix) {
      const start = this.state.pos;
      const startLoc = this.state.curPosition();
      let isBigInt = false;
      this.state.pos += 2;
      const val = this.readInt(radix);
      if (val == null) {
        this.raise(Errors.InvalidDigit, createPositionWithColumnOffset(startLoc, 2), {
          radix
        });
      }
      const next = this.input.charCodeAt(this.state.pos);
      if (next === 110) {
        ++this.state.pos;
        isBigInt = true;
      } else if (next === 109) {
        throw this.raise(Errors.InvalidDecimal, startLoc);
      }
      if (isIdentifierStart(this.codePointAtPos(this.state.pos))) {
        throw this.raise(Errors.NumberIdentifier, this.state.curPosition());
      }
      if (isBigInt) {
        const str = this.input.slice(start, this.state.pos).replace(/[_n]/g, "");
        this.finishToken(136, str);
        return;
      }
      this.finishToken(135, val);
    }
    readNumber(startsWithDot) {
      const start = this.state.pos;
      const startLoc = this.state.curPosition();
      let isFloat = false;
      let isBigInt = false;
      let hasExponent = false;
      let isOctal = false;
      if (!startsWithDot && this.readInt(10) === null) {
        this.raise(Errors.InvalidNumber, this.state.curPosition());
      }
      const hasLeadingZero = this.state.pos - start >= 2 && this.input.charCodeAt(start) === 48;
      if (hasLeadingZero) {
        const integer = this.input.slice(start, this.state.pos);
        this.recordStrictModeErrors(Errors.StrictOctalLiteral, startLoc);
        if (!this.state.strict) {
          const underscorePos = integer.indexOf("_");
          if (underscorePos > 0) {
            this.raise(Errors.ZeroDigitNumericSeparator, createPositionWithColumnOffset(startLoc, underscorePos));
          }
        }
        isOctal = hasLeadingZero && !/[89]/.test(integer);
      }
      let next = this.input.charCodeAt(this.state.pos);
      if (next === 46 && !isOctal) {
        ++this.state.pos;
        this.readInt(10);
        isFloat = true;
        next = this.input.charCodeAt(this.state.pos);
      }
      if ((next === 69 || next === 101) && !isOctal) {
        next = this.input.charCodeAt(++this.state.pos);
        if (next === 43 || next === 45) {
          ++this.state.pos;
        }
        if (this.readInt(10) === null) {
          this.raise(Errors.InvalidOrMissingExponent, startLoc);
        }
        isFloat = true;
        hasExponent = true;
        next = this.input.charCodeAt(this.state.pos);
      }
      if (next === 110) {
        if (isFloat || hasLeadingZero) {
          this.raise(Errors.InvalidBigIntLiteral, startLoc);
        }
        ++this.state.pos;
        isBigInt = true;
      }
      if (next === 109) {
        this.expectPlugin("decimal", this.state.curPosition());
        if (hasExponent || hasLeadingZero) {
          this.raise(Errors.InvalidDecimal, startLoc);
        }
        ++this.state.pos;
        var isDecimal = true;
      }
      if (isIdentifierStart(this.codePointAtPos(this.state.pos))) {
        throw this.raise(Errors.NumberIdentifier, this.state.curPosition());
      }
      const str = this.input.slice(start, this.state.pos).replace(/[_mn]/g, "");
      if (isBigInt) {
        this.finishToken(136, str);
        return;
      }
      if (isDecimal) {
        this.finishToken(137, str);
        return;
      }
      const val = isOctal ? parseInt(str, 8) : parseFloat(str);
      this.finishToken(135, val);
    }
    readCodePoint(throwOnInvalid) {
      const {
        code: code2,
        pos
      } = readCodePoint(this.input, this.state.pos, this.state.lineStart, this.state.curLine, throwOnInvalid, this.errorHandlers_readCodePoint);
      this.state.pos = pos;
      return code2;
    }
    readString(quote) {
      const {
        str,
        pos,
        curLine,
        lineStart
      } = readStringContents(quote === 34 ? "double" : "single", this.input, this.state.pos + 1, this.state.lineStart, this.state.curLine, this.errorHandlers_readStringContents_string);
      this.state.pos = pos + 1;
      this.state.lineStart = lineStart;
      this.state.curLine = curLine;
      this.finishToken(134, str);
    }
    readTemplateContinuation() {
      if (!this.match(8)) {
        this.unexpected(null, 8);
      }
      this.state.pos--;
      this.readTemplateToken();
    }
    readTemplateToken() {
      const opening = this.input[this.state.pos];
      const {
        str,
        firstInvalidLoc,
        pos,
        curLine,
        lineStart
      } = readStringContents("template", this.input, this.state.pos + 1, this.state.lineStart, this.state.curLine, this.errorHandlers_readStringContents_template);
      this.state.pos = pos + 1;
      this.state.lineStart = lineStart;
      this.state.curLine = curLine;
      if (firstInvalidLoc) {
        this.state.firstInvalidTemplateEscapePos = new Position(firstInvalidLoc.curLine, firstInvalidLoc.pos - firstInvalidLoc.lineStart, this.sourceToOffsetPos(firstInvalidLoc.pos));
      }
      if (this.input.codePointAt(pos) === 96) {
        this.finishToken(24, firstInvalidLoc ? null : opening + str + "`");
      } else {
        this.state.pos++;
        this.finishToken(25, firstInvalidLoc ? null : opening + str + "${");
      }
    }
    recordStrictModeErrors(toParseError, at) {
      const index = at.index;
      if (this.state.strict && !this.state.strictErrors.has(index)) {
        this.raise(toParseError, at);
      } else {
        this.state.strictErrors.set(index, [toParseError, at]);
      }
    }
    readWord1(firstCode) {
      this.state.containsEsc = false;
      let word = "";
      const start = this.state.pos;
      let chunkStart = this.state.pos;
      if (firstCode !== undefined) {
        this.state.pos += firstCode <= 65535 ? 1 : 2;
      }
      while (this.state.pos < this.length) {
        const ch = this.codePointAtPos(this.state.pos);
        if (isIdentifierChar(ch)) {
          this.state.pos += ch <= 65535 ? 1 : 2;
        } else if (ch === 92) {
          this.state.containsEsc = true;
          word += this.input.slice(chunkStart, this.state.pos);
          const escStart = this.state.curPosition();
          const identifierCheck = this.state.pos === start ? isIdentifierStart : isIdentifierChar;
          if (this.input.charCodeAt(++this.state.pos) !== 117) {
            this.raise(Errors.MissingUnicodeEscape, this.state.curPosition());
            chunkStart = this.state.pos - 1;
            continue;
          }
          ++this.state.pos;
          const esc = this.readCodePoint(true);
          if (esc !== null) {
            if (!identifierCheck(esc)) {
              this.raise(Errors.EscapedCharNotAnIdentifier, escStart);
            }
            word += String.fromCodePoint(esc);
          }
          chunkStart = this.state.pos;
        } else {
          break;
        }
      }
      return word + this.input.slice(chunkStart, this.state.pos);
    }
    readWord(firstCode) {
      const word = this.readWord1(firstCode);
      const type = keywords$1.get(word);
      if (type !== undefined) {
        this.finishToken(type, tokenLabelName(type));
      } else {
        this.finishToken(132, word);
      }
    }
    checkKeywordEscapes() {
      const {
        type
      } = this.state;
      if (tokenIsKeyword(type) && this.state.containsEsc) {
        this.raise(Errors.InvalidEscapedReservedWord, this.state.startLoc, {
          reservedWord: tokenLabelName(type)
        });
      }
    }
    raise(toParseError, at, details = {}) {
      const loc = at instanceof Position ? at : at.loc.start;
      const error2 = toParseError(loc, details);
      if (!(this.optionFlags & 2048))
        throw error2;
      if (!this.isLookahead)
        this.state.errors.push(error2);
      return error2;
    }
    raiseOverwrite(toParseError, at, details = {}) {
      const loc = at instanceof Position ? at : at.loc.start;
      const pos = loc.index;
      const errors = this.state.errors;
      for (let i = errors.length - 1;i >= 0; i--) {
        const error2 = errors[i];
        if (error2.loc.index === pos) {
          return errors[i] = toParseError(loc, details);
        }
        if (error2.loc.index < pos)
          break;
      }
      return this.raise(toParseError, at, details);
    }
    updateContext(prevType) {}
    unexpected(loc, type) {
      throw this.raise(Errors.UnexpectedToken, loc != null ? loc : this.state.startLoc, {
        expected: type ? tokenLabelName(type) : null
      });
    }
    expectPlugin(pluginName, loc) {
      if (this.hasPlugin(pluginName)) {
        return true;
      }
      throw this.raise(Errors.MissingPlugin, loc != null ? loc : this.state.startLoc, {
        missingPlugin: [pluginName]
      });
    }
    expectOnePlugin(pluginNames) {
      if (!pluginNames.some((name) => this.hasPlugin(name))) {
        throw this.raise(Errors.MissingOneOfPlugins, this.state.startLoc, {
          missingPlugin: pluginNames
        });
      }
    }
    errorBuilder(error2) {
      return (pos, lineStart, curLine) => {
        this.raise(error2, buildPosition(pos, lineStart, curLine));
      };
    }
  }

  class ClassScope {
    constructor() {
      this.privateNames = new Set;
      this.loneAccessors = new Map;
      this.undefinedPrivateNames = new Map;
    }
  }

  class ClassScopeHandler {
    constructor(parser) {
      this.parser = undefined;
      this.stack = [];
      this.undefinedPrivateNames = new Map;
      this.parser = parser;
    }
    current() {
      return this.stack[this.stack.length - 1];
    }
    enter() {
      this.stack.push(new ClassScope);
    }
    exit() {
      const oldClassScope = this.stack.pop();
      const current = this.current();
      for (const [name, loc] of Array.from(oldClassScope.undefinedPrivateNames)) {
        if (current) {
          if (!current.undefinedPrivateNames.has(name)) {
            current.undefinedPrivateNames.set(name, loc);
          }
        } else {
          this.parser.raise(Errors.InvalidPrivateFieldResolution, loc, {
            identifierName: name
          });
        }
      }
    }
    declarePrivateName(name, elementType, loc) {
      const {
        privateNames,
        loneAccessors,
        undefinedPrivateNames
      } = this.current();
      let redefined = privateNames.has(name);
      if (elementType & 3) {
        const accessor = redefined && loneAccessors.get(name);
        if (accessor) {
          const oldStatic = accessor & 4;
          const newStatic = elementType & 4;
          const oldKind = accessor & 3;
          const newKind = elementType & 3;
          redefined = oldKind === newKind || oldStatic !== newStatic;
          if (!redefined)
            loneAccessors.delete(name);
        } else if (!redefined) {
          loneAccessors.set(name, elementType);
        }
      }
      if (redefined) {
        this.parser.raise(Errors.PrivateNameRedeclaration, loc, {
          identifierName: name
        });
      }
      privateNames.add(name);
      undefinedPrivateNames.delete(name);
    }
    usePrivateName(name, loc) {
      let classScope;
      for (classScope of this.stack) {
        if (classScope.privateNames.has(name))
          return;
      }
      if (classScope) {
        classScope.undefinedPrivateNames.set(name, loc);
      } else {
        this.parser.raise(Errors.InvalidPrivateFieldResolution, loc, {
          identifierName: name
        });
      }
    }
  }

  class ExpressionScope {
    constructor(type = 0) {
      this.type = type;
    }
    canBeArrowParameterDeclaration() {
      return this.type === 2 || this.type === 1;
    }
    isCertainlyParameterDeclaration() {
      return this.type === 3;
    }
  }

  class ArrowHeadParsingScope extends ExpressionScope {
    constructor(type) {
      super(type);
      this.declarationErrors = new Map;
    }
    recordDeclarationError(ParsingErrorClass, at) {
      const index = at.index;
      this.declarationErrors.set(index, [ParsingErrorClass, at]);
    }
    clearDeclarationError(index) {
      this.declarationErrors.delete(index);
    }
    iterateErrors(iterator) {
      this.declarationErrors.forEach(iterator);
    }
  }

  class ExpressionScopeHandler {
    constructor(parser) {
      this.parser = undefined;
      this.stack = [new ExpressionScope];
      this.parser = parser;
    }
    enter(scope) {
      this.stack.push(scope);
    }
    exit() {
      this.stack.pop();
    }
    recordParameterInitializerError(toParseError, node) {
      const origin = node.loc.start;
      const {
        stack
      } = this;
      let i = stack.length - 1;
      let scope = stack[i];
      while (!scope.isCertainlyParameterDeclaration()) {
        if (scope.canBeArrowParameterDeclaration()) {
          scope.recordDeclarationError(toParseError, origin);
        } else {
          return;
        }
        scope = stack[--i];
      }
      this.parser.raise(toParseError, origin);
    }
    recordArrowParameterBindingError(error2, node) {
      const {
        stack
      } = this;
      const scope = stack[stack.length - 1];
      const origin = node.loc.start;
      if (scope.isCertainlyParameterDeclaration()) {
        this.parser.raise(error2, origin);
      } else if (scope.canBeArrowParameterDeclaration()) {
        scope.recordDeclarationError(error2, origin);
      } else {
        return;
      }
    }
    recordAsyncArrowParametersError(at) {
      const {
        stack
      } = this;
      let i = stack.length - 1;
      let scope = stack[i];
      while (scope.canBeArrowParameterDeclaration()) {
        if (scope.type === 2) {
          scope.recordDeclarationError(Errors.AwaitBindingIdentifier, at);
        }
        scope = stack[--i];
      }
    }
    validateAsPattern() {
      const {
        stack
      } = this;
      const currentScope = stack[stack.length - 1];
      if (!currentScope.canBeArrowParameterDeclaration())
        return;
      currentScope.iterateErrors(([toParseError, loc]) => {
        this.parser.raise(toParseError, loc);
        let i = stack.length - 2;
        let scope = stack[i];
        while (scope.canBeArrowParameterDeclaration()) {
          scope.clearDeclarationError(loc.index);
          scope = stack[--i];
        }
      });
    }
  }
  function newParameterDeclarationScope() {
    return new ExpressionScope(3);
  }
  function newArrowHeadScope() {
    return new ArrowHeadParsingScope(1);
  }
  function newAsyncArrowScope() {
    return new ArrowHeadParsingScope(2);
  }
  function newExpressionScope() {
    return new ExpressionScope;
  }

  class UtilParser extends Tokenizer {
    addExtra(node, key, value, enumerable = true) {
      if (!node)
        return;
      let {
        extra
      } = node;
      if (extra == null) {
        extra = {};
        node.extra = extra;
      }
      if (enumerable) {
        extra[key] = value;
      } else {
        Object.defineProperty(extra, key, {
          enumerable,
          value
        });
      }
    }
    isContextual(token) {
      return this.state.type === token && !this.state.containsEsc;
    }
    isUnparsedContextual(nameStart, name) {
      if (this.input.startsWith(name, nameStart)) {
        const nextCh = this.input.charCodeAt(nameStart + name.length);
        return !(isIdentifierChar(nextCh) || (nextCh & 64512) === 55296);
      }
      return false;
    }
    isLookaheadContextual(name) {
      const next = this.nextTokenStart();
      return this.isUnparsedContextual(next, name);
    }
    eatContextual(token) {
      if (this.isContextual(token)) {
        this.next();
        return true;
      }
      return false;
    }
    expectContextual(token, toParseError) {
      if (!this.eatContextual(token)) {
        if (toParseError != null) {
          throw this.raise(toParseError, this.state.startLoc);
        }
        this.unexpected(null, token);
      }
    }
    canInsertSemicolon() {
      return this.match(140) || this.match(8) || this.hasPrecedingLineBreak();
    }
    hasPrecedingLineBreak() {
      return hasNewLine(this.input, this.offsetToSourcePos(this.state.lastTokEndLoc.index), this.state.start);
    }
    hasFollowingLineBreak() {
      return hasNewLine(this.input, this.state.end, this.nextTokenStart());
    }
    isLineTerminator() {
      return this.eat(13) || this.canInsertSemicolon();
    }
    semicolon(allowAsi = true) {
      if (allowAsi ? this.isLineTerminator() : this.eat(13))
        return;
      this.raise(Errors.MissingSemicolon, this.state.lastTokEndLoc);
    }
    expect(type, loc) {
      if (!this.eat(type)) {
        this.unexpected(loc, type);
      }
    }
    tryParse(fn, oldState = this.state.clone()) {
      const abortSignal = {
        node: null
      };
      try {
        const node = fn((node2 = null) => {
          abortSignal.node = node2;
          throw abortSignal;
        });
        if (this.state.errors.length > oldState.errors.length) {
          const failState = this.state;
          this.state = oldState;
          this.state.tokensLength = failState.tokensLength;
          return {
            node,
            error: failState.errors[oldState.errors.length],
            thrown: false,
            aborted: false,
            failState
          };
        }
        return {
          node,
          error: null,
          thrown: false,
          aborted: false,
          failState: null
        };
      } catch (error2) {
        const failState = this.state;
        this.state = oldState;
        if (error2 instanceof SyntaxError) {
          return {
            node: null,
            error: error2,
            thrown: true,
            aborted: false,
            failState
          };
        }
        if (error2 === abortSignal) {
          return {
            node: abortSignal.node,
            error: null,
            thrown: false,
            aborted: true,
            failState
          };
        }
        throw error2;
      }
    }
    checkExpressionErrors(refExpressionErrors, andThrow) {
      if (!refExpressionErrors)
        return false;
      const {
        shorthandAssignLoc,
        doubleProtoLoc,
        privateKeyLoc,
        optionalParametersLoc,
        voidPatternLoc
      } = refExpressionErrors;
      const hasErrors = !!shorthandAssignLoc || !!doubleProtoLoc || !!optionalParametersLoc || !!privateKeyLoc || !!voidPatternLoc;
      if (!andThrow) {
        return hasErrors;
      }
      if (shorthandAssignLoc != null) {
        this.raise(Errors.InvalidCoverInitializedName, shorthandAssignLoc);
      }
      if (doubleProtoLoc != null) {
        this.raise(Errors.DuplicateProto, doubleProtoLoc);
      }
      if (privateKeyLoc != null) {
        this.raise(Errors.UnexpectedPrivateField, privateKeyLoc);
      }
      if (optionalParametersLoc != null) {
        this.unexpected(optionalParametersLoc);
      }
      if (voidPatternLoc != null) {
        this.raise(Errors.InvalidCoverDiscardElement, voidPatternLoc);
      }
    }
    isLiteralPropertyName() {
      return tokenIsLiteralPropertyName(this.state.type);
    }
    isPrivateName(node) {
      return node.type === "PrivateName";
    }
    getPrivateNameSV(node) {
      return node.id.name;
    }
    hasPropertyAsPrivateName(node) {
      return (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") && this.isPrivateName(node.property);
    }
    isObjectProperty(node) {
      return node.type === "ObjectProperty";
    }
    isObjectMethod(node) {
      return node.type === "ObjectMethod";
    }
    initializeScopes(inModule = this.options.sourceType === "module") {
      const oldLabels = this.state.labels;
      this.state.labels = [];
      const oldExportedIdentifiers = this.exportedIdentifiers;
      this.exportedIdentifiers = new Set;
      const oldInModule = this.inModule;
      this.inModule = inModule;
      const oldScope = this.scope;
      const ScopeHandler2 = this.getScopeHandler();
      this.scope = new ScopeHandler2(this, inModule);
      const oldProdParam = this.prodParam;
      this.prodParam = new ProductionParameterHandler;
      const oldClassScope = this.classScope;
      this.classScope = new ClassScopeHandler(this);
      const oldExpressionScope = this.expressionScope;
      this.expressionScope = new ExpressionScopeHandler(this);
      return () => {
        this.state.labels = oldLabels;
        this.exportedIdentifiers = oldExportedIdentifiers;
        this.inModule = oldInModule;
        this.scope = oldScope;
        this.prodParam = oldProdParam;
        this.classScope = oldClassScope;
        this.expressionScope = oldExpressionScope;
      };
    }
    enterInitialScopes() {
      let paramFlags = 0;
      if (this.inModule || this.optionFlags & 1) {
        paramFlags |= 2;
      }
      if (this.optionFlags & 32) {
        paramFlags |= 1;
      }
      const isCommonJS = !this.inModule && this.options.sourceType === "commonjs";
      if (isCommonJS || this.optionFlags & 2) {
        paramFlags |= 4;
      }
      this.prodParam.enter(paramFlags);
      let scopeFlags = isCommonJS ? 514 : 1;
      if (this.optionFlags & 4) {
        scopeFlags |= 512;
      }
      this.scope.enter(scopeFlags);
    }
    checkDestructuringPrivate(refExpressionErrors) {
      const {
        privateKeyLoc
      } = refExpressionErrors;
      if (privateKeyLoc !== null) {
        this.expectPlugin("destructuringPrivate", privateKeyLoc);
      }
    }
  }

  class ExpressionErrors {
    constructor() {
      this.shorthandAssignLoc = null;
      this.doubleProtoLoc = null;
      this.privateKeyLoc = null;
      this.optionalParametersLoc = null;
      this.voidPatternLoc = null;
    }
  }

  class Node {
    constructor(parser, pos, loc) {
      this.type = "";
      this.start = pos;
      this.end = 0;
      this.loc = new SourceLocation(loc);
      if ((parser == null ? undefined : parser.optionFlags) & 128)
        this.range = [pos, 0];
      if (parser != null && parser.filename)
        this.loc.filename = parser.filename;
    }
  }
  var NodePrototype = Node.prototype;
  NodePrototype.__clone = function() {
    const newNode = new Node(undefined, this.start, this.loc.start);
    const keys = Object.keys(this);
    for (let i = 0, length = keys.length;i < length; i++) {
      const key = keys[i];
      if (key !== "leadingComments" && key !== "trailingComments" && key !== "innerComments") {
        newNode[key] = this[key];
      }
    }
    return newNode;
  };

  class NodeUtils extends UtilParser {
    startNode() {
      const loc = this.state.startLoc;
      return new Node(this, loc.index, loc);
    }
    startNodeAt(loc) {
      return new Node(this, loc.index, loc);
    }
    startNodeAtNode(type) {
      return this.startNodeAt(type.loc.start);
    }
    finishNode(node, type) {
      return this.finishNodeAt(node, type, this.state.lastTokEndLoc);
    }
    finishNodeAt(node, type, endLoc) {
      node.type = type;
      node.end = endLoc.index;
      node.loc.end = endLoc;
      if (this.optionFlags & 128)
        node.range[1] = endLoc.index;
      if (this.optionFlags & 4096) {
        this.processComment(node);
      }
      return node;
    }
    resetStartLocation(node, startLoc) {
      node.start = startLoc.index;
      node.loc.start = startLoc;
      if (this.optionFlags & 128)
        node.range[0] = startLoc.index;
    }
    resetEndLocation(node, endLoc = this.state.lastTokEndLoc) {
      node.end = endLoc.index;
      node.loc.end = endLoc;
      if (this.optionFlags & 128)
        node.range[1] = endLoc.index;
    }
    resetStartLocationFromNode(node, locationNode) {
      this.resetStartLocation(node, locationNode.loc.start);
    }
    castNodeTo(node, type) {
      node.type = type;
      return node;
    }
    cloneIdentifier(node) {
      const {
        type,
        start,
        end,
        loc,
        range,
        name
      } = node;
      const cloned = Object.create(NodePrototype);
      cloned.type = type;
      cloned.start = start;
      cloned.end = end;
      cloned.loc = loc;
      cloned.range = range;
      cloned.name = name;
      if (node.extra)
        cloned.extra = node.extra;
      return cloned;
    }
    cloneStringLiteral(node) {
      const {
        type,
        start,
        end,
        loc,
        range,
        extra
      } = node;
      const cloned = Object.create(NodePrototype);
      cloned.type = type;
      cloned.start = start;
      cloned.end = end;
      cloned.loc = loc;
      cloned.range = range;
      cloned.extra = extra;
      cloned.value = node.value;
      return cloned;
    }
  }
  var unwrapParenthesizedExpression = (node) => {
    return node.type === "ParenthesizedExpression" ? unwrapParenthesizedExpression(node.expression) : node;
  };

  class LValParser extends NodeUtils {
    toAssignable(node, isLHS = false) {
      var _node$extra, _node$extra3;
      let parenthesized = undefined;
      if (node.type === "ParenthesizedExpression" || (_node$extra = node.extra) != null && _node$extra.parenthesized) {
        parenthesized = unwrapParenthesizedExpression(node);
        if (isLHS) {
          if (parenthesized.type === "Identifier") {
            this.expressionScope.recordArrowParameterBindingError(Errors.InvalidParenthesizedAssignment, node);
          } else if (parenthesized.type !== "CallExpression" && parenthesized.type !== "MemberExpression" && !this.isOptionalMemberExpression(parenthesized)) {
            this.raise(Errors.InvalidParenthesizedAssignment, node);
          }
        } else {
          this.raise(Errors.InvalidParenthesizedAssignment, node);
        }
      }
      switch (node.type) {
        case "Identifier":
        case "ObjectPattern":
        case "ArrayPattern":
        case "AssignmentPattern":
        case "RestElement":
        case "VoidPattern":
          break;
        case "ObjectExpression":
          this.castNodeTo(node, "ObjectPattern");
          for (let i = 0, length = node.properties.length, last = length - 1;i < length; i++) {
            var _node$extra2;
            const prop = node.properties[i];
            const isLast = i === last;
            this.toAssignableObjectExpressionProp(prop, isLast, isLHS);
            if (isLast && prop.type === "RestElement" && (_node$extra2 = node.extra) != null && _node$extra2.trailingCommaLoc) {
              this.raise(Errors.RestTrailingComma, node.extra.trailingCommaLoc);
            }
          }
          break;
        case "ObjectProperty": {
          const {
            key,
            value
          } = node;
          if (this.isPrivateName(key)) {
            this.classScope.usePrivateName(this.getPrivateNameSV(key), key.loc.start);
          }
          this.toAssignable(value, isLHS);
          break;
        }
        case "SpreadElement": {
          throw new Error("Internal @babel/parser error (this is a bug, please report it)." + " SpreadElement should be converted by .toAssignable's caller.");
        }
        case "ArrayExpression":
          this.castNodeTo(node, "ArrayPattern");
          this.toAssignableList(node.elements, (_node$extra3 = node.extra) == null ? undefined : _node$extra3.trailingCommaLoc, isLHS);
          break;
        case "AssignmentExpression":
          if (node.operator !== "=") {
            this.raise(Errors.MissingEqInAssignment, node.left.loc.end);
          }
          this.castNodeTo(node, "AssignmentPattern");
          delete node.operator;
          if (node.left.type === "VoidPattern") {
            this.raise(Errors.VoidPatternInitializer, node.left);
          }
          this.toAssignable(node.left, isLHS);
          break;
        case "ParenthesizedExpression":
          this.toAssignable(parenthesized, isLHS);
          break;
      }
    }
    toAssignableObjectExpressionProp(prop, isLast, isLHS) {
      if (prop.type === "ObjectMethod") {
        this.raise(prop.kind === "get" || prop.kind === "set" ? Errors.PatternHasAccessor : Errors.PatternHasMethod, prop.key);
      } else if (prop.type === "SpreadElement") {
        this.castNodeTo(prop, "RestElement");
        const arg = prop.argument;
        this.checkToRestConversion(arg, false);
        this.toAssignable(arg, isLHS);
        if (!isLast) {
          this.raise(Errors.RestTrailingComma, prop);
        }
      } else {
        this.toAssignable(prop, isLHS);
      }
    }
    toAssignableList(exprList, trailingCommaLoc, isLHS) {
      const end = exprList.length - 1;
      for (let i = 0;i <= end; i++) {
        const elt = exprList[i];
        if (!elt)
          continue;
        this.toAssignableListItem(exprList, i, isLHS);
        if (elt.type === "RestElement") {
          if (i < end) {
            this.raise(Errors.RestTrailingComma, elt);
          } else if (trailingCommaLoc) {
            this.raise(Errors.RestTrailingComma, trailingCommaLoc);
          }
        }
      }
    }
    toAssignableListItem(exprList, index, isLHS) {
      const node = exprList[index];
      if (node.type === "SpreadElement") {
        this.castNodeTo(node, "RestElement");
        const arg = node.argument;
        this.checkToRestConversion(arg, true);
        this.toAssignable(arg, isLHS);
      } else {
        this.toAssignable(node, isLHS);
      }
    }
    isAssignable(node, isBinding) {
      switch (node.type) {
        case "Identifier":
        case "ObjectPattern":
        case "ArrayPattern":
        case "AssignmentPattern":
        case "RestElement":
        case "VoidPattern":
          return true;
        case "ObjectExpression": {
          const last = node.properties.length - 1;
          return node.properties.every((prop, i) => {
            return prop.type !== "ObjectMethod" && (i === last || prop.type !== "SpreadElement") && this.isAssignable(prop);
          });
        }
        case "ObjectProperty":
          return this.isAssignable(node.value);
        case "SpreadElement":
          return this.isAssignable(node.argument);
        case "ArrayExpression":
          return node.elements.every((element) => element === null || this.isAssignable(element));
        case "AssignmentExpression":
          return node.operator === "=";
        case "ParenthesizedExpression":
          return this.isAssignable(node.expression);
        case "MemberExpression":
        case "OptionalMemberExpression":
          return !isBinding;
        default:
          return false;
      }
    }
    toReferencedList(exprList, isParenthesizedExpr) {
      return exprList;
    }
    toReferencedListDeep(exprList, isParenthesizedExpr) {
      this.toReferencedList(exprList, isParenthesizedExpr);
      for (const expr of exprList) {
        if ((expr == null ? undefined : expr.type) === "ArrayExpression") {
          this.toReferencedListDeep(expr.elements);
        }
      }
    }
    parseSpread(refExpressionErrors) {
      const node = this.startNode();
      this.next();
      node.argument = this.parseMaybeAssignAllowIn(refExpressionErrors, undefined);
      return this.finishNode(node, "SpreadElement");
    }
    parseRestBinding() {
      const node = this.startNode();
      this.next();
      const argument = this.parseBindingAtom();
      if (argument.type === "VoidPattern") {
        this.raise(Errors.UnexpectedVoidPattern, argument);
      }
      node.argument = argument;
      return this.finishNode(node, "RestElement");
    }
    parseBindingAtom() {
      switch (this.state.type) {
        case 0: {
          const node = this.startNode();
          this.next();
          node.elements = this.parseBindingList(3, 93, 1);
          return this.finishNode(node, "ArrayPattern");
        }
        case 5:
          return this.parseObjectLike(8, true);
        case 88:
          return this.parseVoidPattern(null);
      }
      return this.parseIdentifier();
    }
    parseBindingList(close, closeCharCode, flags) {
      const allowEmpty = flags & 1;
      const elts = [];
      let first = true;
      while (!this.eat(close)) {
        if (first) {
          first = false;
        } else {
          this.expect(12);
        }
        if (allowEmpty && this.match(12)) {
          elts.push(null);
        } else if (this.eat(close)) {
          break;
        } else if (this.match(21)) {
          let rest = this.parseRestBinding();
          if (this.hasPlugin("flow") || flags & 2) {
            rest = this.parseFunctionParamType(rest);
          }
          elts.push(rest);
          if (!this.checkCommaAfterRest(closeCharCode)) {
            this.expect(close);
            break;
          }
        } else {
          const decorators = [];
          if (flags & 2) {
            if (this.match(26) && this.hasPlugin("decorators")) {
              this.raise(Errors.UnsupportedParameterDecorator, this.state.startLoc);
            }
            while (this.match(26)) {
              decorators.push(this.parseDecorator());
            }
          }
          elts.push(this.parseBindingElement(flags, decorators));
        }
      }
      return elts;
    }
    parseBindingRestProperty(prop) {
      this.next();
      if (this.hasPlugin("discardBinding") && this.match(88)) {
        prop.argument = this.parseVoidPattern(null);
        this.raise(Errors.UnexpectedVoidPattern, prop.argument);
      } else {
        prop.argument = this.parseIdentifier();
      }
      this.checkCommaAfterRest(125);
      return this.finishNode(prop, "RestElement");
    }
    parseBindingProperty() {
      const {
        type,
        startLoc
      } = this.state;
      if (type === 21) {
        return this.parseBindingRestProperty(this.startNode());
      }
      const prop = this.startNode();
      if (type === 139) {
        this.expectPlugin("destructuringPrivate", startLoc);
        this.classScope.usePrivateName(this.state.value, startLoc);
        prop.key = this.parsePrivateName();
      } else {
        this.parsePropertyName(prop);
      }
      prop.method = false;
      return this.parseObjPropValue(prop, startLoc, false, false, true, false);
    }
    parseBindingElement(flags, decorators) {
      const left = this.parseMaybeDefault();
      if (this.hasPlugin("flow") || flags & 2) {
        this.parseFunctionParamType(left);
      }
      if (decorators.length) {
        left.decorators = decorators;
        this.resetStartLocationFromNode(left, decorators[0]);
      }
      const elt = this.parseMaybeDefault(left.loc.start, left);
      return elt;
    }
    parseFunctionParamType(param) {
      return param;
    }
    parseMaybeDefault(startLoc, left) {
      startLoc != null || (startLoc = this.state.startLoc);
      left = left != null ? left : this.parseBindingAtom();
      if (!this.eat(29))
        return left;
      const node = this.startNodeAt(startLoc);
      if (left.type === "VoidPattern") {
        this.raise(Errors.VoidPatternInitializer, left);
      }
      node.left = left;
      node.right = this.parseMaybeAssignAllowIn();
      return this.finishNode(node, "AssignmentPattern");
    }
    isValidLVal(type, disallowCallExpression, isUnparenthesizedInAssign, binding) {
      switch (type) {
        case "AssignmentPattern":
          return "left";
        case "RestElement":
          return "argument";
        case "ObjectProperty":
          return "value";
        case "ParenthesizedExpression":
          return "expression";
        case "ArrayPattern":
          return "elements";
        case "ObjectPattern":
          return "properties";
        case "VoidPattern":
          return true;
        case "CallExpression":
          if (!disallowCallExpression && !this.state.strict && this.optionFlags & 8192) {
            return true;
          }
      }
      return false;
    }
    isOptionalMemberExpression(expression) {
      return expression.type === "OptionalMemberExpression";
    }
    checkLVal(expression, ancestor, binding = 64, checkClashes = false, strictModeChanged = false, hasParenthesizedAncestor = false, disallowCallExpression = false) {
      var _expression$extra;
      const type = expression.type;
      if (this.isObjectMethod(expression))
        return;
      const isOptionalMemberExpression = this.isOptionalMemberExpression(expression);
      if (isOptionalMemberExpression || type === "MemberExpression") {
        if (isOptionalMemberExpression) {
          this.expectPlugin("optionalChainingAssign", expression.loc.start);
          if (ancestor.type !== "AssignmentExpression") {
            this.raise(Errors.InvalidLhsOptionalChaining, expression, {
              ancestor
            });
          }
        }
        if (binding !== 64) {
          this.raise(Errors.InvalidPropertyBindingPattern, expression);
        }
        return;
      }
      if (type === "Identifier") {
        this.checkIdentifier(expression, binding, strictModeChanged);
        const {
          name
        } = expression;
        if (checkClashes) {
          if (checkClashes.has(name)) {
            this.raise(Errors.ParamDupe, expression);
          } else {
            checkClashes.add(name);
          }
        }
        return;
      } else if (type === "VoidPattern" && ancestor.type === "CatchClause") {
        this.raise(Errors.VoidPatternCatchClauseParam, expression);
      }
      const unwrappedExpression = unwrapParenthesizedExpression(expression);
      disallowCallExpression || (disallowCallExpression = unwrappedExpression.type === "CallExpression" && (unwrappedExpression.callee.type === "Import" || unwrappedExpression.callee.type === "Super"));
      const validity = this.isValidLVal(type, disallowCallExpression, !(hasParenthesizedAncestor || (_expression$extra = expression.extra) != null && _expression$extra.parenthesized) && ancestor.type === "AssignmentExpression", binding);
      if (validity === true)
        return;
      if (validity === false) {
        const ParseErrorClass = binding === 64 ? Errors.InvalidLhs : Errors.InvalidLhsBinding;
        this.raise(ParseErrorClass, expression, {
          ancestor
        });
        return;
      }
      let key, isParenthesizedExpression;
      if (typeof validity === "string") {
        key = validity;
        isParenthesizedExpression = type === "ParenthesizedExpression";
      } else {
        [key, isParenthesizedExpression] = validity;
      }
      const nextAncestor = type === "ArrayPattern" || type === "ObjectPattern" ? {
        type
      } : ancestor;
      const val = expression[key];
      if (Array.isArray(val)) {
        for (const child of val) {
          if (child) {
            this.checkLVal(child, nextAncestor, binding, checkClashes, strictModeChanged, isParenthesizedExpression, true);
          }
        }
      } else if (val) {
        this.checkLVal(val, nextAncestor, binding, checkClashes, strictModeChanged, isParenthesizedExpression, disallowCallExpression);
      }
    }
    checkIdentifier(at, bindingType, strictModeChanged = false) {
      if (this.state.strict && (strictModeChanged ? isStrictBindReservedWord(at.name, this.inModule) : isStrictBindOnlyReservedWord(at.name))) {
        if (bindingType === 64) {
          this.raise(Errors.StrictEvalArguments, at, {
            referenceName: at.name
          });
        } else {
          this.raise(Errors.StrictEvalArgumentsBinding, at, {
            bindingName: at.name
          });
        }
      }
      if (bindingType & 8192 && at.name === "let") {
        this.raise(Errors.LetInLexicalBinding, at);
      }
      if (!(bindingType & 64)) {
        this.declareNameFromIdentifier(at, bindingType);
      }
    }
    declareNameFromIdentifier(identifier, binding) {
      this.scope.declareName(identifier.name, binding, identifier.loc.start);
    }
    checkToRestConversion(node, allowPattern) {
      switch (node.type) {
        case "ParenthesizedExpression":
          this.checkToRestConversion(node.expression, allowPattern);
          break;
        case "Identifier":
        case "MemberExpression":
          break;
        case "ArrayExpression":
        case "ObjectExpression":
          if (allowPattern)
            break;
        default:
          this.raise(Errors.InvalidRestAssignmentPattern, node);
      }
    }
    checkCommaAfterRest(close) {
      if (!this.match(12)) {
        return false;
      }
      this.raise(this.lookaheadCharCode() === close ? Errors.RestTrailingComma : Errors.ElementAfterRest, this.state.startLoc);
      return true;
    }
  }
  var keywordAndTSRelationalOperator = /in(?:stanceof)?|as|satisfies/y;
  function nonNull(x) {
    if (x == null) {
      throw new Error(`Unexpected ${x} value.`);
    }
    return x;
  }
  function assert(x) {
    if (!x) {
      throw new Error("Assert fail");
    }
  }
  var TSErrors = ParseErrorEnum`typescript`({
    AbstractMethodHasImplementation: ({
      methodName
    }) => `Method '${methodName}' cannot have an implementation because it is marked abstract.`,
    AbstractPropertyHasInitializer: ({
      propertyName
    }) => `Property '${propertyName}' cannot have an initializer because it is marked abstract.`,
    AccessorCannotBeOptional: "An 'accessor' property cannot be declared optional.",
    AccessorCannotDeclareThisParameter: "'get' and 'set' accessors cannot declare 'this' parameters.",
    AccessorCannotHaveTypeParameters: "An accessor cannot have type parameters.",
    ClassMethodHasDeclare: "Class methods cannot have the 'declare' modifier.",
    ClassMethodHasReadonly: "Class methods cannot have the 'readonly' modifier.",
    ConstInitializerMustBeStringOrNumericLiteralOrLiteralEnumReference: "A 'const' initializer in an ambient context must be a string or numeric literal or literal enum reference.",
    ConstructorHasTypeParameters: "Type parameters cannot appear on a constructor declaration.",
    DeclareAccessor: ({
      kind
    }) => `'declare' is not allowed in ${kind}ters.`,
    DeclareClassFieldHasInitializer: "Initializers are not allowed in ambient contexts.",
    DeclareFunctionHasImplementation: "An implementation cannot be declared in ambient contexts.",
    DuplicateAccessibilityModifier: ({
      modifier
    }) => `Accessibility modifier already seen: '${modifier}'.`,
    DuplicateModifier: ({
      modifier
    }) => `Duplicate modifier: '${modifier}'.`,
    EmptyHeritageClauseType: ({
      token
    }) => `'${token}' list cannot be empty.`,
    EmptyTypeArguments: "Type argument list cannot be empty.",
    EmptyTypeParameters: "Type parameter list cannot be empty.",
    ExpectedAmbientAfterExportDeclare: "'export declare' must be followed by an ambient declaration.",
    ImportAliasHasImportType: "An import alias can not use 'import type'.",
    ImportReflectionHasImportType: "An `import module` declaration can not use `type` modifier",
    IncompatibleModifiers: ({
      modifiers
    }) => `'${modifiers[0]}' modifier cannot be used with '${modifiers[1]}' modifier.`,
    IndexSignatureHasAbstract: "Index signatures cannot have the 'abstract' modifier.",
    IndexSignatureHasAccessibility: ({
      modifier
    }) => `Index signatures cannot have an accessibility modifier ('${modifier}').`,
    IndexSignatureHasDeclare: "Index signatures cannot have the 'declare' modifier.",
    IndexSignatureHasOverride: "'override' modifier cannot appear on an index signature.",
    IndexSignatureHasStatic: "Index signatures cannot have the 'static' modifier.",
    InitializerNotAllowedInAmbientContext: "Initializers are not allowed in ambient contexts.",
    InvalidHeritageClauseType: ({
      token
    }) => `'${token}' list can only include identifiers or qualified-names with optional type arguments.`,
    InvalidModifierOnAwaitUsingDeclaration: (modifier) => `'${modifier}' modifier cannot appear on an await using declaration.`,
    InvalidModifierOnTypeMember: ({
      modifier
    }) => `'${modifier}' modifier cannot appear on a type member.`,
    InvalidModifierOnTypeParameter: ({
      modifier
    }) => `'${modifier}' modifier cannot appear on a type parameter.`,
    InvalidModifierOnTypeParameterPositions: ({
      modifier
    }) => `'${modifier}' modifier can only appear on a type parameter of a class, interface or type alias.`,
    InvalidModifierOnUsingDeclaration: (modifier) => `'${modifier}' modifier cannot appear on a using declaration.`,
    InvalidModifiersOrder: ({
      orderedModifiers
    }) => `'${orderedModifiers[0]}' modifier must precede '${orderedModifiers[1]}' modifier.`,
    InvalidPropertyAccessAfterInstantiationExpression: "Invalid property access after an instantiation expression. " + "You can either wrap the instantiation expression in parentheses, or delete the type arguments.",
    InvalidTupleMemberLabel: "Tuple members must be labeled with a simple identifier.",
    MissingInterfaceName: "'interface' declarations must be followed by an identifier.",
    NonAbstractClassHasAbstractMethod: "Abstract methods can only appear within an abstract class.",
    NonClassMethodPropertyHasAbstractModifier: "'abstract' modifier can only appear on a class, method, or property declaration.",
    OptionalTypeBeforeRequired: "A required element cannot follow an optional element.",
    OverrideNotInSubClass: "This member cannot have an 'override' modifier because its containing class does not extend another class.",
    PatternIsOptional: "A binding pattern parameter cannot be optional in an implementation signature.",
    PrivateElementHasAbstract: "Private elements cannot have the 'abstract' modifier.",
    PrivateElementHasAccessibility: ({
      modifier
    }) => `Private elements cannot have an accessibility modifier ('${modifier}').`,
    ReadonlyForMethodSignature: "'readonly' modifier can only appear on a property declaration or index signature.",
    ReservedArrowTypeParam: "This syntax is reserved in files with the .mts or .cts extension. Add a trailing comma, as in `<T,>() => ...`.",
    ReservedTypeAssertion: "This syntax is reserved in files with the .mts or .cts extension. Use an `as` expression instead.",
    SetAccessorCannotHaveOptionalParameter: "A 'set' accessor cannot have an optional parameter.",
    SetAccessorCannotHaveRestParameter: "A 'set' accessor cannot have rest parameter.",
    SetAccessorCannotHaveReturnType: "A 'set' accessor cannot have a return type annotation.",
    SingleTypeParameterWithoutTrailingComma: ({
      typeParameterName
    }) => `Single type parameter ${typeParameterName} should have a trailing comma. Example usage: <${typeParameterName},>.`,
    StaticBlockCannotHaveModifier: "Static class blocks cannot have any modifier.",
    TupleOptionalAfterType: "A labeled tuple optional element must be declared using a question mark after the name and before the colon (`name?: type`), rather than after the type (`name: type?`).",
    TypeAnnotationAfterAssign: "Type annotations must come before default assignments, e.g. instead of `age = 25: number` use `age: number = 25`.",
    TypeImportCannotSpecifyDefaultAndNamed: "A type-only import can specify a default import or named bindings, but not both.",
    TypeModifierIsUsedInTypeExports: "The 'type' modifier cannot be used on a named export when 'export type' is used on its export statement.",
    TypeModifierIsUsedInTypeImports: "The 'type' modifier cannot be used on a named import when 'import type' is used on its import statement.",
    UnexpectedParameterModifier: "A parameter property is only allowed in a constructor implementation.",
    UnexpectedReadonly: "'readonly' type modifier is only permitted on array and tuple literal types.",
    UnexpectedTypeAnnotation: "Did not expect a type annotation here.",
    UnexpectedTypeCastInParameter: "Unexpected type cast in parameter position.",
    UnsupportedImportTypeArgument: "Argument in a type import must be a string literal.",
    UnsupportedParameterPropertyKind: "A parameter property may not be declared using a binding pattern.",
    UnsupportedSignatureParameterKind: ({
      type
    }) => `Name in a signature must be an Identifier, ObjectPattern or ArrayPattern, instead got ${type}.`,
    UsingDeclarationInAmbientContext: (kind) => `'${kind}' declarations are not allowed in ambient contexts.`
  });
  function keywordTypeFromName(value) {
    switch (value) {
      case "any":
        return "TSAnyKeyword";
      case "boolean":
        return "TSBooleanKeyword";
      case "bigint":
        return "TSBigIntKeyword";
      case "never":
        return "TSNeverKeyword";
      case "number":
        return "TSNumberKeyword";
      case "object":
        return "TSObjectKeyword";
      case "string":
        return "TSStringKeyword";
      case "symbol":
        return "TSSymbolKeyword";
      case "undefined":
        return "TSUndefinedKeyword";
      case "unknown":
        return "TSUnknownKeyword";
      default:
        return;
    }
  }
  function tsIsAccessModifier(modifier) {
    return modifier === "private" || modifier === "public" || modifier === "protected";
  }
  function tsIsVarianceAnnotations(modifier) {
    return modifier === "in" || modifier === "out";
  }
  var typescript = (superClass) => class TypeScriptParserMixin extends superClass {
    constructor(...args) {
      super(...args);
      this.tsParseInOutModifiers = this.tsParseModifiers.bind(this, {
        allowedModifiers: ["in", "out"],
        disallowedModifiers: ["const", "public", "private", "protected", "readonly", "declare", "abstract", "override"],
        errorTemplate: TSErrors.InvalidModifierOnTypeParameter
      });
      this.tsParseConstModifier = this.tsParseModifiers.bind(this, {
        allowedModifiers: ["const"],
        disallowedModifiers: ["in", "out"],
        errorTemplate: TSErrors.InvalidModifierOnTypeParameterPositions
      });
      this.tsParseInOutConstModifiers = this.tsParseModifiers.bind(this, {
        allowedModifiers: ["in", "out", "const"],
        disallowedModifiers: ["public", "private", "protected", "readonly", "declare", "abstract", "override"],
        errorTemplate: TSErrors.InvalidModifierOnTypeParameter
      });
    }
    getScopeHandler() {
      return TypeScriptScopeHandler;
    }
    tsIsIdentifier() {
      return tokenIsIdentifier(this.state.type);
    }
    tsTokenCanFollowModifier() {
      return this.match(0) || this.match(5) || this.match(55) || this.match(21) || this.match(139) || this.isLiteralPropertyName();
    }
    tsNextTokenOnSameLineAndCanFollowModifier() {
      this.next();
      if (this.hasPrecedingLineBreak()) {
        return false;
      }
      return this.tsTokenCanFollowModifier();
    }
    tsNextTokenCanFollowModifier() {
      if (this.match(106)) {
        this.next();
        return this.tsTokenCanFollowModifier();
      }
      return this.tsNextTokenOnSameLineAndCanFollowModifier();
    }
    tsParseModifier(allowedModifiers, stopOnStartOfClassStaticBlock, hasSeenStaticModifier) {
      if (!tokenIsIdentifier(this.state.type) && this.state.type !== 58 && this.state.type !== 75) {
        return;
      }
      const modifier = this.state.value;
      if (allowedModifiers.includes(modifier)) {
        if (hasSeenStaticModifier && this.match(106)) {
          return;
        }
        if (stopOnStartOfClassStaticBlock && this.tsIsStartOfStaticBlocks()) {
          return;
        }
        if (this.tsTryParse(this.tsNextTokenCanFollowModifier.bind(this))) {
          return modifier;
        }
      }
      return;
    }
    tsParseModifiers({
      allowedModifiers,
      disallowedModifiers,
      stopOnStartOfClassStaticBlock,
      errorTemplate = TSErrors.InvalidModifierOnTypeMember
    }, modified) {
      const enforceOrder = (loc, modifier, before, after) => {
        if (modifier === before && modified[after]) {
          this.raise(TSErrors.InvalidModifiersOrder, loc, {
            orderedModifiers: [before, after]
          });
        }
      };
      const incompatible = (loc, modifier, mod1, mod2) => {
        if (modified[mod1] && modifier === mod2 || modified[mod2] && modifier === mod1) {
          this.raise(TSErrors.IncompatibleModifiers, loc, {
            modifiers: [mod1, mod2]
          });
        }
      };
      for (;; ) {
        const {
          startLoc
        } = this.state;
        const modifier = this.tsParseModifier(allowedModifiers.concat(disallowedModifiers != null ? disallowedModifiers : []), stopOnStartOfClassStaticBlock, modified.static);
        if (!modifier)
          break;
        if (tsIsAccessModifier(modifier)) {
          if (modified.accessibility) {
            this.raise(TSErrors.DuplicateAccessibilityModifier, startLoc, {
              modifier
            });
          } else {
            enforceOrder(startLoc, modifier, modifier, "override");
            enforceOrder(startLoc, modifier, modifier, "static");
            enforceOrder(startLoc, modifier, modifier, "readonly");
            modified.accessibility = modifier;
          }
        } else if (tsIsVarianceAnnotations(modifier)) {
          if (modified[modifier]) {
            this.raise(TSErrors.DuplicateModifier, startLoc, {
              modifier
            });
          }
          modified[modifier] = true;
          enforceOrder(startLoc, modifier, "in", "out");
        } else {
          if (hasOwnProperty.call(modified, modifier)) {
            this.raise(TSErrors.DuplicateModifier, startLoc, {
              modifier
            });
          } else {
            enforceOrder(startLoc, modifier, "static", "readonly");
            enforceOrder(startLoc, modifier, "static", "override");
            enforceOrder(startLoc, modifier, "override", "readonly");
            enforceOrder(startLoc, modifier, "abstract", "override");
            incompatible(startLoc, modifier, "declare", "override");
            incompatible(startLoc, modifier, "static", "abstract");
          }
          modified[modifier] = true;
        }
        if (disallowedModifiers != null && disallowedModifiers.includes(modifier)) {
          this.raise(errorTemplate, startLoc, {
            modifier
          });
        }
      }
    }
    tsIsListTerminator(kind) {
      switch (kind) {
        case "EnumMembers":
        case "TypeMembers":
          return this.match(8);
        case "HeritageClauseElement":
          return this.match(5);
        case "TupleElementTypes":
          return this.match(3);
        case "TypeParametersOrArguments":
          return this.match(48);
      }
    }
    tsParseList(kind, parseElement) {
      const result = [];
      while (!this.tsIsListTerminator(kind)) {
        result.push(parseElement());
      }
      return result;
    }
    tsParseDelimitedList(kind, parseElement, refTrailingCommaPos) {
      return nonNull(this.tsParseDelimitedListWorker(kind, parseElement, true, refTrailingCommaPos));
    }
    tsParseDelimitedListWorker(kind, parseElement, expectSuccess, refTrailingCommaPos) {
      const result = [];
      let trailingCommaPos = -1;
      for (;; ) {
        if (this.tsIsListTerminator(kind)) {
          break;
        }
        trailingCommaPos = -1;
        const element = parseElement();
        if (element == null) {
          return;
        }
        result.push(element);
        if (this.eat(12)) {
          trailingCommaPos = this.state.lastTokStartLoc.index;
          continue;
        }
        if (this.tsIsListTerminator(kind)) {
          break;
        }
        if (expectSuccess) {
          this.expect(12);
        }
        return;
      }
      if (refTrailingCommaPos) {
        refTrailingCommaPos.value = trailingCommaPos;
      }
      return result;
    }
    tsParseBracketedList(kind, parseElement, bracket, skipFirstToken, refTrailingCommaPos) {
      if (!skipFirstToken) {
        if (bracket) {
          this.expect(0);
        } else {
          this.expect(47);
        }
      }
      const result = this.tsParseDelimitedList(kind, parseElement, refTrailingCommaPos);
      if (bracket) {
        this.expect(3);
      } else {
        this.expect(48);
      }
      return result;
    }
    tsParseImportType() {
      const node = this.startNode();
      this.expect(83);
      this.expect(10);
      if (!this.match(134)) {
        this.raise(TSErrors.UnsupportedImportTypeArgument, this.state.startLoc);
        node.argument = super.parseExprAtom();
      } else {
        node.argument = this.parseStringLiteral(this.state.value);
      }
      if (this.eat(12)) {
        node.options = this.tsParseImportTypeOptions();
      } else {
        node.options = null;
      }
      this.expect(11);
      if (this.eat(16)) {
        node.qualifier = this.tsParseEntityName(1 | 2);
      }
      if (this.match(47)) {
        node.typeParameters = this.tsParseTypeArguments();
      }
      return this.finishNode(node, "TSImportType");
    }
    tsParseImportTypeOptions() {
      const node = this.startNode();
      this.expect(5);
      const withProperty = this.startNode();
      if (this.isContextual(76)) {
        withProperty.method = false;
        withProperty.key = this.parseIdentifier(true);
        withProperty.computed = false;
        withProperty.shorthand = false;
      } else {
        this.unexpected(null, 76);
      }
      this.expect(14);
      withProperty.value = this.tsParseImportTypeWithPropertyValue();
      node.properties = [this.finishObjectProperty(withProperty)];
      this.eat(12);
      this.expect(8);
      return this.finishNode(node, "ObjectExpression");
    }
    tsParseImportTypeWithPropertyValue() {
      const node = this.startNode();
      const properties = [];
      this.expect(5);
      while (!this.match(8)) {
        const type = this.state.type;
        if (tokenIsIdentifier(type) || type === 134) {
          properties.push(super.parsePropertyDefinition(null));
        } else {
          this.unexpected();
        }
        this.eat(12);
      }
      node.properties = properties;
      this.next();
      return this.finishNode(node, "ObjectExpression");
    }
    tsParseEntityName(flags) {
      let entity;
      if (flags & 1 && this.match(78)) {
        if (flags & 2) {
          entity = this.parseIdentifier(true);
        } else {
          const node = this.startNode();
          this.next();
          entity = this.finishNode(node, "ThisExpression");
        }
      } else {
        entity = this.parseIdentifier(!!(flags & 1));
      }
      while (this.eat(16)) {
        const node = this.startNodeAtNode(entity);
        node.left = entity;
        node.right = this.parseIdentifier(!!(flags & 1));
        entity = this.finishNode(node, "TSQualifiedName");
      }
      return entity;
    }
    tsParseTypeReference() {
      const node = this.startNode();
      node.typeName = this.tsParseEntityName(1);
      if (!this.hasPrecedingLineBreak() && this.match(47)) {
        node.typeParameters = this.tsParseTypeArguments();
      }
      return this.finishNode(node, "TSTypeReference");
    }
    tsParseThisTypePredicate(lhs) {
      this.next();
      const node = this.startNodeAtNode(lhs);
      node.parameterName = lhs;
      node.typeAnnotation = this.tsParseTypeAnnotation(false);
      node.asserts = false;
      return this.finishNode(node, "TSTypePredicate");
    }
    tsParseThisTypeNode() {
      const node = this.startNode();
      this.next();
      return this.finishNode(node, "TSThisType");
    }
    tsParseTypeQuery() {
      const node = this.startNode();
      this.expect(87);
      if (this.match(83)) {
        node.exprName = this.tsParseImportType();
      } else {
        node.exprName = this.tsParseEntityName(1 | 2);
      }
      if (!this.hasPrecedingLineBreak() && this.match(47)) {
        node.typeParameters = this.tsParseTypeArguments();
      }
      return this.finishNode(node, "TSTypeQuery");
    }
    tsParseTypeParameter(parseModifiers) {
      const node = this.startNode();
      parseModifiers(node);
      node.name = this.tsParseTypeParameterName();
      node.constraint = this.tsEatThenParseType(81);
      node.default = this.tsEatThenParseType(29);
      return this.finishNode(node, "TSTypeParameter");
    }
    tsTryParseTypeParameters(parseModifiers) {
      if (this.match(47)) {
        return this.tsParseTypeParameters(parseModifiers);
      }
    }
    tsParseTypeParameters(parseModifiers) {
      const node = this.startNode();
      if (this.match(47) || this.match(143)) {
        this.next();
      } else {
        this.unexpected();
      }
      const refTrailingCommaPos = {
        value: -1
      };
      node.params = this.tsParseBracketedList("TypeParametersOrArguments", this.tsParseTypeParameter.bind(this, parseModifiers), false, true, refTrailingCommaPos);
      if (node.params.length === 0) {
        this.raise(TSErrors.EmptyTypeParameters, node);
      }
      if (refTrailingCommaPos.value !== -1) {
        this.addExtra(node, "trailingComma", refTrailingCommaPos.value);
      }
      return this.finishNode(node, "TSTypeParameterDeclaration");
    }
    tsFillSignature(returnToken, signature) {
      const returnTokenRequired = returnToken === 19;
      const paramsKey = "parameters";
      const returnTypeKey = "typeAnnotation";
      signature.typeParameters = this.tsTryParseTypeParameters(this.tsParseConstModifier);
      this.expect(10);
      signature[paramsKey] = this.tsParseBindingListForSignature();
      if (returnTokenRequired) {
        signature[returnTypeKey] = this.tsParseTypeOrTypePredicateAnnotation(returnToken);
      } else if (this.match(returnToken)) {
        signature[returnTypeKey] = this.tsParseTypeOrTypePredicateAnnotation(returnToken);
      }
    }
    tsParseBindingListForSignature() {
      const list = super.parseBindingList(11, 41, 2);
      for (const pattern of list) {
        const {
          type
        } = pattern;
        if (type === "AssignmentPattern" || type === "TSParameterProperty") {
          this.raise(TSErrors.UnsupportedSignatureParameterKind, pattern, {
            type
          });
        }
      }
      return list;
    }
    tsParseTypeMemberSemicolon() {
      if (!this.eat(12) && !this.isLineTerminator()) {
        this.expect(13);
      }
    }
    tsParseSignatureMember(kind, node) {
      this.tsFillSignature(14, node);
      this.tsParseTypeMemberSemicolon();
      return this.finishNode(node, kind);
    }
    tsIsUnambiguouslyIndexSignature() {
      this.next();
      if (tokenIsIdentifier(this.state.type)) {
        this.next();
        return this.match(14);
      }
      return false;
    }
    tsTryParseIndexSignature(node) {
      if (!(this.match(0) && this.tsLookAhead(this.tsIsUnambiguouslyIndexSignature.bind(this)))) {
        return;
      }
      this.expect(0);
      const id = this.parseIdentifier();
      id.typeAnnotation = this.tsParseTypeAnnotation();
      this.resetEndLocation(id);
      this.expect(3);
      node.parameters = [id];
      const type = this.tsTryParseTypeAnnotation();
      if (type)
        node.typeAnnotation = type;
      this.tsParseTypeMemberSemicolon();
      return this.finishNode(node, "TSIndexSignature");
    }
    tsParsePropertyOrMethodSignature(node, readonly) {
      if (this.eat(17))
        node.optional = true;
      if (this.match(10) || this.match(47)) {
        if (readonly) {
          this.raise(TSErrors.ReadonlyForMethodSignature, node);
        }
        const method = node;
        if (method.kind && this.match(47)) {
          this.raise(TSErrors.AccessorCannotHaveTypeParameters, this.state.curPosition());
        }
        this.tsFillSignature(14, method);
        this.tsParseTypeMemberSemicolon();
        const paramsKey = "parameters";
        const returnTypeKey = "typeAnnotation";
        if (method.kind === "get") {
          if (method[paramsKey].length > 0) {
            this.raise(Errors.BadGetterArity, this.state.curPosition());
            if (this.isThisParam(method[paramsKey][0])) {
              this.raise(TSErrors.AccessorCannotDeclareThisParameter, this.state.curPosition());
            }
          }
        } else if (method.kind === "set") {
          if (method[paramsKey].length !== 1) {
            this.raise(Errors.BadSetterArity, this.state.curPosition());
          } else {
            const firstParameter = method[paramsKey][0];
            if (this.isThisParam(firstParameter)) {
              this.raise(TSErrors.AccessorCannotDeclareThisParameter, this.state.curPosition());
            }
            if (firstParameter.type === "Identifier" && firstParameter.optional) {
              this.raise(TSErrors.SetAccessorCannotHaveOptionalParameter, this.state.curPosition());
            }
            if (firstParameter.type === "RestElement") {
              this.raise(TSErrors.SetAccessorCannotHaveRestParameter, this.state.curPosition());
            }
          }
          if (method[returnTypeKey]) {
            this.raise(TSErrors.SetAccessorCannotHaveReturnType, method[returnTypeKey]);
          }
        } else {
          method.kind = "method";
        }
        return this.finishNode(method, "TSMethodSignature");
      } else {
        const property = node;
        if (readonly)
          property.readonly = true;
        const type = this.tsTryParseTypeAnnotation();
        if (type)
          property.typeAnnotation = type;
        this.tsParseTypeMemberSemicolon();
        return this.finishNode(property, "TSPropertySignature");
      }
    }
    tsParseTypeMember() {
      const node = this.startNode();
      if (this.match(10) || this.match(47)) {
        return this.tsParseSignatureMember("TSCallSignatureDeclaration", node);
      }
      if (this.match(77)) {
        const id = this.startNode();
        this.next();
        if (this.match(10) || this.match(47)) {
          return this.tsParseSignatureMember("TSConstructSignatureDeclaration", node);
        } else {
          node.key = this.createIdentifier(id, "new");
          return this.tsParsePropertyOrMethodSignature(node, false);
        }
      }
      this.tsParseModifiers({
        allowedModifiers: ["readonly"],
        disallowedModifiers: ["declare", "abstract", "private", "protected", "public", "static", "override"]
      }, node);
      const idx = this.tsTryParseIndexSignature(node);
      if (idx) {
        return idx;
      }
      super.parsePropertyName(node);
      if (!node.computed && node.key.type === "Identifier" && (node.key.name === "get" || node.key.name === "set") && this.tsTokenCanFollowModifier()) {
        node.kind = node.key.name;
        super.parsePropertyName(node);
        if (!this.match(10) && !this.match(47)) {
          this.unexpected(null, 10);
        }
      }
      return this.tsParsePropertyOrMethodSignature(node, !!node.readonly);
    }
    tsParseTypeLiteral() {
      const node = this.startNode();
      node.members = this.tsParseObjectTypeMembers();
      return this.finishNode(node, "TSTypeLiteral");
    }
    tsParseObjectTypeMembers() {
      this.expect(5);
      const members = this.tsParseList("TypeMembers", this.tsParseTypeMember.bind(this));
      this.expect(8);
      return members;
    }
    tsIsStartOfMappedType() {
      this.next();
      if (this.eat(53)) {
        return this.isContextual(122);
      }
      if (this.isContextual(122)) {
        this.next();
      }
      if (!this.match(0)) {
        return false;
      }
      this.next();
      if (!this.tsIsIdentifier()) {
        return false;
      }
      this.next();
      return this.match(58);
    }
    tsParseMappedType() {
      const node = this.startNode();
      this.expect(5);
      if (this.match(53)) {
        node.readonly = this.state.value;
        this.next();
        this.expectContextual(122);
      } else if (this.eatContextual(122)) {
        node.readonly = true;
      }
      this.expect(0);
      const typeParameter = this.startNode();
      typeParameter.name = this.tsParseTypeParameterName();
      typeParameter.constraint = this.tsExpectThenParseType(58);
      node.typeParameter = this.finishNode(typeParameter, "TSTypeParameter");
      node.nameType = this.eatContextual(93) ? this.tsParseType() : null;
      this.expect(3);
      if (this.match(53)) {
        node.optional = this.state.value;
        this.next();
        this.expect(17);
      } else if (this.eat(17)) {
        node.optional = true;
      }
      node.typeAnnotation = this.tsTryParseType();
      this.semicolon();
      this.expect(8);
      return this.finishNode(node, "TSMappedType");
    }
    tsParseTupleType() {
      const node = this.startNode();
      node.elementTypes = this.tsParseBracketedList("TupleElementTypes", this.tsParseTupleElementType.bind(this), true, false);
      let seenOptionalElement = false;
      node.elementTypes.forEach((elementNode) => {
        const {
          type
        } = elementNode;
        if (seenOptionalElement && type !== "TSRestType" && type !== "TSOptionalType" && !(type === "TSNamedTupleMember" && elementNode.optional)) {
          this.raise(TSErrors.OptionalTypeBeforeRequired, elementNode);
        }
        seenOptionalElement || (seenOptionalElement = type === "TSNamedTupleMember" && elementNode.optional || type === "TSOptionalType");
      });
      return this.finishNode(node, "TSTupleType");
    }
    tsParseTupleElementType() {
      const restStartLoc = this.state.startLoc;
      const rest = this.eat(21);
      const {
        startLoc
      } = this.state;
      let labeled;
      let label;
      let optional;
      let type;
      const isWord = tokenIsKeywordOrIdentifier(this.state.type);
      const chAfterWord = isWord ? this.lookaheadCharCode() : null;
      if (chAfterWord === 58) {
        labeled = true;
        optional = false;
        label = this.parseIdentifier(true);
        this.expect(14);
        type = this.tsParseType();
      } else if (chAfterWord === 63) {
        optional = true;
        const wordName = this.state.value;
        const typeOrLabel = this.tsParseNonArrayType();
        if (this.lookaheadCharCode() === 58) {
          labeled = true;
          label = this.createIdentifier(this.startNodeAt(startLoc), wordName);
          this.expect(17);
          this.expect(14);
          type = this.tsParseType();
        } else {
          labeled = false;
          type = typeOrLabel;
          this.expect(17);
        }
      } else {
        type = this.tsParseType();
        optional = this.eat(17);
        labeled = this.eat(14);
      }
      if (labeled) {
        let labeledNode;
        if (label) {
          labeledNode = this.startNodeAt(startLoc);
          labeledNode.optional = optional;
          labeledNode.label = label;
          labeledNode.elementType = type;
          if (this.eat(17)) {
            labeledNode.optional = true;
            this.raise(TSErrors.TupleOptionalAfterType, this.state.lastTokStartLoc);
          }
        } else {
          labeledNode = this.startNodeAt(startLoc);
          labeledNode.optional = optional;
          this.raise(TSErrors.InvalidTupleMemberLabel, type);
          labeledNode.label = type;
          labeledNode.elementType = this.tsParseType();
        }
        type = this.finishNode(labeledNode, "TSNamedTupleMember");
      } else if (optional) {
        const optionalTypeNode = this.startNodeAt(startLoc);
        optionalTypeNode.typeAnnotation = type;
        type = this.finishNode(optionalTypeNode, "TSOptionalType");
      }
      if (rest) {
        const restNode = this.startNodeAt(restStartLoc);
        restNode.typeAnnotation = type;
        type = this.finishNode(restNode, "TSRestType");
      }
      return type;
    }
    tsParseParenthesizedType() {
      const node = this.startNode();
      this.expect(10);
      node.typeAnnotation = this.tsParseType();
      this.expect(11);
      return this.finishNode(node, "TSParenthesizedType");
    }
    tsParseFunctionOrConstructorType(type, abstract) {
      const node = this.startNode();
      if (type === "TSConstructorType") {
        node.abstract = !!abstract;
        if (abstract)
          this.next();
        this.next();
      }
      this.tsInAllowConditionalTypesContext(() => this.tsFillSignature(19, node));
      return this.finishNode(node, type);
    }
    tsParseLiteralTypeNode() {
      const node = this.startNode();
      switch (this.state.type) {
        case 135:
        case 136:
        case 134:
        case 85:
        case 86:
          node.literal = super.parseExprAtom();
          break;
        default:
          this.unexpected();
      }
      return this.finishNode(node, "TSLiteralType");
    }
    tsParseTemplateLiteralType() {
      const node = this.startNode();
      node.literal = super.parseTemplate(false);
      return this.finishNode(node, "TSLiteralType");
    }
    parseTemplateSubstitution() {
      if (this.state.inType)
        return this.tsParseType();
      return super.parseTemplateSubstitution();
    }
    tsParseThisTypeOrThisTypePredicate() {
      const thisKeyword = this.tsParseThisTypeNode();
      if (this.isContextual(116) && !this.hasPrecedingLineBreak()) {
        return this.tsParseThisTypePredicate(thisKeyword);
      } else {
        return thisKeyword;
      }
    }
    tsParseNonArrayType() {
      switch (this.state.type) {
        case 134:
        case 135:
        case 136:
        case 85:
        case 86:
          return this.tsParseLiteralTypeNode();
        case 53:
          if (this.state.value === "-") {
            const node = this.startNode();
            const nextToken = this.lookahead();
            if (nextToken.type !== 135 && nextToken.type !== 136) {
              this.unexpected();
            }
            node.literal = this.parseMaybeUnary();
            return this.finishNode(node, "TSLiteralType");
          }
          break;
        case 78:
          return this.tsParseThisTypeOrThisTypePredicate();
        case 87:
          return this.tsParseTypeQuery();
        case 83:
          return this.tsParseImportType();
        case 5:
          return this.tsLookAhead(this.tsIsStartOfMappedType.bind(this)) ? this.tsParseMappedType() : this.tsParseTypeLiteral();
        case 0:
          return this.tsParseTupleType();
        case 10:
          return this.tsParseParenthesizedType();
        case 25:
        case 24:
          return this.tsParseTemplateLiteralType();
        default: {
          const {
            type
          } = this.state;
          if (tokenIsIdentifier(type) || type === 88 || type === 84) {
            const nodeType = type === 88 ? "TSVoidKeyword" : type === 84 ? "TSNullKeyword" : keywordTypeFromName(this.state.value);
            if (nodeType !== undefined && this.lookaheadCharCode() !== 46) {
              const node = this.startNode();
              this.next();
              return this.finishNode(node, nodeType);
            }
            return this.tsParseTypeReference();
          }
        }
      }
      throw this.unexpected();
    }
    tsParseArrayTypeOrHigher() {
      const {
        startLoc
      } = this.state;
      let type = this.tsParseNonArrayType();
      while (!this.hasPrecedingLineBreak() && this.eat(0)) {
        if (this.match(3)) {
          const node = this.startNodeAt(startLoc);
          node.elementType = type;
          this.expect(3);
          type = this.finishNode(node, "TSArrayType");
        } else {
          const node = this.startNodeAt(startLoc);
          node.objectType = type;
          node.indexType = this.tsParseType();
          this.expect(3);
          type = this.finishNode(node, "TSIndexedAccessType");
        }
      }
      return type;
    }
    tsParseTypeOperator() {
      const node = this.startNode();
      const operator = this.state.value;
      this.next();
      node.operator = operator;
      node.typeAnnotation = this.tsParseTypeOperatorOrHigher();
      if (operator === "readonly") {
        this.tsCheckTypeAnnotationForReadOnly(node);
      }
      return this.finishNode(node, "TSTypeOperator");
    }
    tsCheckTypeAnnotationForReadOnly(node) {
      switch (node.typeAnnotation.type) {
        case "TSTupleType":
        case "TSArrayType":
          return;
        default:
          this.raise(TSErrors.UnexpectedReadonly, node);
      }
    }
    tsParseInferType() {
      const node = this.startNode();
      this.expectContextual(115);
      const typeParameter = this.startNode();
      typeParameter.name = this.tsParseTypeParameterName();
      typeParameter.constraint = this.tsTryParse(() => this.tsParseConstraintForInferType());
      node.typeParameter = this.finishNode(typeParameter, "TSTypeParameter");
      return this.finishNode(node, "TSInferType");
    }
    tsParseConstraintForInferType() {
      if (this.eat(81)) {
        const constraint = this.tsInDisallowConditionalTypesContext(() => this.tsParseType());
        if (this.state.inDisallowConditionalTypesContext || !this.match(17)) {
          return constraint;
        }
      }
    }
    tsParseTypeOperatorOrHigher() {
      const isTypeOperator = tokenIsTSTypeOperator(this.state.type) && !this.state.containsEsc;
      return isTypeOperator ? this.tsParseTypeOperator() : this.isContextual(115) ? this.tsParseInferType() : this.tsInAllowConditionalTypesContext(() => this.tsParseArrayTypeOrHigher());
    }
    tsParseUnionOrIntersectionType(kind, parseConstituentType, operator) {
      const node = this.startNode();
      const hasLeadingOperator = this.eat(operator);
      const types2 = [];
      do {
        types2.push(parseConstituentType());
      } while (this.eat(operator));
      if (types2.length === 1 && !hasLeadingOperator) {
        return types2[0];
      }
      node.types = types2;
      return this.finishNode(node, kind);
    }
    tsParseIntersectionTypeOrHigher() {
      return this.tsParseUnionOrIntersectionType("TSIntersectionType", this.tsParseTypeOperatorOrHigher.bind(this), 45);
    }
    tsParseUnionTypeOrHigher() {
      return this.tsParseUnionOrIntersectionType("TSUnionType", this.tsParseIntersectionTypeOrHigher.bind(this), 43);
    }
    tsIsStartOfFunctionType() {
      if (this.match(47)) {
        return true;
      }
      return this.match(10) && this.tsLookAhead(this.tsIsUnambiguouslyStartOfFunctionType.bind(this));
    }
    tsSkipParameterStart() {
      if (tokenIsIdentifier(this.state.type) || this.match(78)) {
        this.next();
        return true;
      }
      if (this.match(5)) {
        const {
          errors
        } = this.state;
        const previousErrorCount = errors.length;
        try {
          this.parseObjectLike(8, true);
          return errors.length === previousErrorCount;
        } catch (_unused) {
          return false;
        }
      }
      if (this.match(0)) {
        this.next();
        const {
          errors
        } = this.state;
        const previousErrorCount = errors.length;
        try {
          super.parseBindingList(3, 93, 1);
          return errors.length === previousErrorCount;
        } catch (_unused2) {
          return false;
        }
      }
      return false;
    }
    tsIsUnambiguouslyStartOfFunctionType() {
      this.next();
      if (this.match(11) || this.match(21)) {
        return true;
      }
      if (this.tsSkipParameterStart()) {
        if (this.match(14) || this.match(12) || this.match(17) || this.match(29)) {
          return true;
        }
        if (this.match(11)) {
          this.next();
          if (this.match(19)) {
            return true;
          }
        }
      }
      return false;
    }
    tsParseTypeOrTypePredicateAnnotation(returnToken) {
      return this.tsInType(() => {
        const t = this.startNode();
        this.expect(returnToken);
        const node = this.startNode();
        const asserts = !!this.tsTryParse(this.tsParseTypePredicateAsserts.bind(this));
        if (asserts && this.match(78)) {
          let thisTypePredicate = this.tsParseThisTypeOrThisTypePredicate();
          if (thisTypePredicate.type === "TSThisType") {
            node.parameterName = thisTypePredicate;
            node.asserts = true;
            node.typeAnnotation = null;
            thisTypePredicate = this.finishNode(node, "TSTypePredicate");
          } else {
            this.resetStartLocationFromNode(thisTypePredicate, node);
            thisTypePredicate.asserts = true;
          }
          t.typeAnnotation = thisTypePredicate;
          return this.finishNode(t, "TSTypeAnnotation");
        }
        const typePredicateVariable = this.tsIsIdentifier() && this.tsTryParse(this.tsParseTypePredicatePrefix.bind(this));
        if (!typePredicateVariable) {
          if (!asserts) {
            return this.tsParseTypeAnnotation(false, t);
          }
          node.parameterName = this.parseIdentifier();
          node.asserts = asserts;
          node.typeAnnotation = null;
          t.typeAnnotation = this.finishNode(node, "TSTypePredicate");
          return this.finishNode(t, "TSTypeAnnotation");
        }
        const type = this.tsParseTypeAnnotation(false);
        node.parameterName = typePredicateVariable;
        node.typeAnnotation = type;
        node.asserts = asserts;
        t.typeAnnotation = this.finishNode(node, "TSTypePredicate");
        return this.finishNode(t, "TSTypeAnnotation");
      });
    }
    tsTryParseTypeOrTypePredicateAnnotation() {
      if (this.match(14)) {
        return this.tsParseTypeOrTypePredicateAnnotation(14);
      }
    }
    tsTryParseTypeAnnotation() {
      if (this.match(14)) {
        return this.tsParseTypeAnnotation();
      }
    }
    tsTryParseType() {
      return this.tsEatThenParseType(14);
    }
    tsParseTypePredicatePrefix() {
      const id = this.parseIdentifier();
      if (this.isContextual(116) && !this.hasPrecedingLineBreak()) {
        this.next();
        return id;
      }
    }
    tsParseTypePredicateAsserts() {
      if (this.state.type !== 109) {
        return false;
      }
      const containsEsc = this.state.containsEsc;
      this.next();
      if (!tokenIsIdentifier(this.state.type) && !this.match(78)) {
        return false;
      }
      if (containsEsc) {
        this.raise(Errors.InvalidEscapedReservedWord, this.state.lastTokStartLoc, {
          reservedWord: "asserts"
        });
      }
      return true;
    }
    tsParseTypeAnnotation(eatColon = true, t = this.startNode()) {
      this.tsInType(() => {
        if (eatColon)
          this.expect(14);
        t.typeAnnotation = this.tsParseType();
      });
      return this.finishNode(t, "TSTypeAnnotation");
    }
    tsParseType() {
      assert(this.state.inType);
      const type = this.tsParseNonConditionalType();
      if (this.state.inDisallowConditionalTypesContext || this.hasPrecedingLineBreak() || !this.eat(81)) {
        return type;
      }
      const node = this.startNodeAtNode(type);
      node.checkType = type;
      node.extendsType = this.tsInDisallowConditionalTypesContext(() => this.tsParseNonConditionalType());
      this.expect(17);
      node.trueType = this.tsInAllowConditionalTypesContext(() => this.tsParseType());
      this.expect(14);
      node.falseType = this.tsInAllowConditionalTypesContext(() => this.tsParseType());
      return this.finishNode(node, "TSConditionalType");
    }
    isAbstractConstructorSignature() {
      return this.isContextual(124) && this.isLookaheadContextual("new");
    }
    tsParseNonConditionalType() {
      if (this.tsIsStartOfFunctionType()) {
        return this.tsParseFunctionOrConstructorType("TSFunctionType");
      }
      if (this.match(77)) {
        return this.tsParseFunctionOrConstructorType("TSConstructorType");
      } else if (this.isAbstractConstructorSignature()) {
        return this.tsParseFunctionOrConstructorType("TSConstructorType", true);
      }
      return this.tsParseUnionTypeOrHigher();
    }
    tsParseTypeAssertion() {
      if (this.getPluginOption("typescript", "disallowAmbiguousJSXLike")) {
        this.raise(TSErrors.ReservedTypeAssertion, this.state.startLoc);
      }
      const node = this.startNode();
      node.typeAnnotation = this.tsInType(() => {
        this.next();
        return this.match(75) ? this.tsParseTypeReference() : this.tsParseType();
      });
      this.expect(48);
      node.expression = this.parseMaybeUnary();
      return this.finishNode(node, "TSTypeAssertion");
    }
    tsParseHeritageClause(token) {
      const originalStartLoc = this.state.startLoc;
      const delimitedList = this.tsParseDelimitedList("HeritageClauseElement", () => {
        const node = this.startNode();
        node.expression = this.tsParseEntityName(1 | 2);
        if (this.match(47)) {
          node.typeParameters = this.tsParseTypeArguments();
        }
        return this.finishNode(node, "TSExpressionWithTypeArguments");
      });
      if (!delimitedList.length) {
        this.raise(TSErrors.EmptyHeritageClauseType, originalStartLoc, {
          token
        });
      }
      return delimitedList;
    }
    tsParseInterfaceDeclaration(node, properties = {}) {
      if (this.hasFollowingLineBreak())
        return null;
      this.expectContextual(129);
      if (properties.declare)
        node.declare = true;
      if (tokenIsIdentifier(this.state.type)) {
        node.id = this.parseIdentifier();
        this.checkIdentifier(node.id, 130);
      } else {
        node.id = null;
        this.raise(TSErrors.MissingInterfaceName, this.state.startLoc);
      }
      node.typeParameters = this.tsTryParseTypeParameters(this.tsParseInOutConstModifiers);
      if (this.eat(81)) {
        node.extends = this.tsParseHeritageClause("extends");
      }
      const body = this.startNode();
      body.body = this.tsInType(this.tsParseObjectTypeMembers.bind(this));
      node.body = this.finishNode(body, "TSInterfaceBody");
      return this.finishNode(node, "TSInterfaceDeclaration");
    }
    tsParseTypeAliasDeclaration(node) {
      node.id = this.parseIdentifier();
      this.checkIdentifier(node.id, 2);
      node.typeAnnotation = this.tsInType(() => {
        node.typeParameters = this.tsTryParseTypeParameters(this.tsParseInOutModifiers);
        this.expect(29);
        if (this.isContextual(114) && this.lookaheadCharCode() !== 46) {
          const node2 = this.startNode();
          this.next();
          return this.finishNode(node2, "TSIntrinsicKeyword");
        }
        return this.tsParseType();
      });
      this.semicolon();
      return this.finishNode(node, "TSTypeAliasDeclaration");
    }
    tsInTopLevelContext(cb) {
      if (this.curContext() !== types.brace) {
        const oldContext = this.state.context;
        this.state.context = [oldContext[0]];
        try {
          return cb();
        } finally {
          this.state.context = oldContext;
        }
      } else {
        return cb();
      }
    }
    tsInType(cb) {
      const oldInType = this.state.inType;
      this.state.inType = true;
      try {
        return cb();
      } finally {
        this.state.inType = oldInType;
      }
    }
    tsInDisallowConditionalTypesContext(cb) {
      const oldInDisallowConditionalTypesContext = this.state.inDisallowConditionalTypesContext;
      this.state.inDisallowConditionalTypesContext = true;
      try {
        return cb();
      } finally {
        this.state.inDisallowConditionalTypesContext = oldInDisallowConditionalTypesContext;
      }
    }
    tsInAllowConditionalTypesContext(cb) {
      const oldInDisallowConditionalTypesContext = this.state.inDisallowConditionalTypesContext;
      this.state.inDisallowConditionalTypesContext = false;
      try {
        return cb();
      } finally {
        this.state.inDisallowConditionalTypesContext = oldInDisallowConditionalTypesContext;
      }
    }
    tsEatThenParseType(token) {
      if (this.match(token)) {
        return this.tsNextThenParseType();
      }
    }
    tsExpectThenParseType(token) {
      return this.tsInType(() => {
        this.expect(token);
        return this.tsParseType();
      });
    }
    tsNextThenParseType() {
      return this.tsInType(() => {
        this.next();
        return this.tsParseType();
      });
    }
    tsParseEnumMember() {
      const node = this.startNode();
      node.id = this.match(134) ? super.parseStringLiteral(this.state.value) : this.parseIdentifier(true);
      if (this.eat(29)) {
        node.initializer = super.parseMaybeAssignAllowIn();
      }
      return this.finishNode(node, "TSEnumMember");
    }
    tsParseEnumDeclaration(node, properties = {}) {
      if (properties.const)
        node.const = true;
      if (properties.declare)
        node.declare = true;
      this.expectContextual(126);
      node.id = this.parseIdentifier();
      this.checkIdentifier(node.id, node.const ? 8971 : 8459);
      this.expect(5);
      node.members = this.tsParseDelimitedList("EnumMembers", this.tsParseEnumMember.bind(this));
      this.expect(8);
      return this.finishNode(node, "TSEnumDeclaration");
    }
    tsParseEnumBody() {
      const node = this.startNode();
      this.expect(5);
      node.members = this.tsParseDelimitedList("EnumMembers", this.tsParseEnumMember.bind(this));
      this.expect(8);
      return this.finishNode(node, "TSEnumBody");
    }
    tsParseModuleBlock() {
      const node = this.startNode();
      this.scope.enter(0);
      this.expect(5);
      super.parseBlockOrModuleBlockBody(node.body = [], undefined, true, 8);
      this.scope.exit();
      return this.finishNode(node, "TSModuleBlock");
    }
    tsParseModuleOrNamespaceDeclaration(node, nested = false) {
      node.id = this.parseIdentifier();
      if (!nested) {
        this.checkIdentifier(node.id, 1024);
      }
      if (this.eat(16)) {
        const inner = this.startNode();
        this.tsParseModuleOrNamespaceDeclaration(inner, true);
        node.body = inner;
      } else {
        this.scope.enter(1024);
        this.prodParam.enter(0);
        node.body = this.tsParseModuleBlock();
        this.prodParam.exit();
        this.scope.exit();
      }
      return this.finishNode(node, "TSModuleDeclaration");
    }
    tsParseAmbientExternalModuleDeclaration(node) {
      if (this.isContextual(112)) {
        node.kind = "global";
        node.global = true;
        node.id = this.parseIdentifier();
      } else if (this.match(134)) {
        node.kind = "module";
        node.id = super.parseStringLiteral(this.state.value);
      } else {
        this.unexpected();
      }
      if (this.match(5)) {
        this.scope.enter(1024);
        this.prodParam.enter(0);
        node.body = this.tsParseModuleBlock();
        this.prodParam.exit();
        this.scope.exit();
      } else {
        this.semicolon();
      }
      return this.finishNode(node, "TSModuleDeclaration");
    }
    tsParseImportEqualsDeclaration(node, maybeDefaultIdentifier, isExport) {
      node.isExport = isExport || false;
      node.id = maybeDefaultIdentifier || this.parseIdentifier();
      this.checkIdentifier(node.id, 4096);
      this.expect(29);
      const moduleReference = this.tsParseModuleReference();
      if (node.importKind === "type" && moduleReference.type !== "TSExternalModuleReference") {
        this.raise(TSErrors.ImportAliasHasImportType, moduleReference);
      }
      node.moduleReference = moduleReference;
      this.semicolon();
      return this.finishNode(node, "TSImportEqualsDeclaration");
    }
    tsIsExternalModuleReference() {
      return this.isContextual(119) && this.lookaheadCharCode() === 40;
    }
    tsParseModuleReference() {
      return this.tsIsExternalModuleReference() ? this.tsParseExternalModuleReference() : this.tsParseEntityName(0);
    }
    tsParseExternalModuleReference() {
      const node = this.startNode();
      this.expectContextual(119);
      this.expect(10);
      if (!this.match(134)) {
        this.unexpected();
      }
      node.expression = super.parseExprAtom();
      this.expect(11);
      this.sawUnambiguousESM = true;
      return this.finishNode(node, "TSExternalModuleReference");
    }
    tsLookAhead(f) {
      const state = this.state.clone();
      const res = f();
      this.state = state;
      return res;
    }
    tsTryParseAndCatch(f) {
      const result = this.tryParse((abort) => f() || abort());
      if (result.aborted || !result.node)
        return;
      if (result.error)
        this.state = result.failState;
      return result.node;
    }
    tsTryParse(f) {
      const state = this.state.clone();
      const result = f();
      if (result !== undefined && result !== false) {
        return result;
      }
      this.state = state;
    }
    tsTryParseDeclare(node) {
      if (this.isLineTerminator()) {
        return;
      }
      const startType = this.state.type;
      return this.tsInAmbientContext(() => {
        switch (startType) {
          case 68:
            node.declare = true;
            return super.parseFunctionStatement(node, false, false);
          case 80:
            node.declare = true;
            return this.parseClass(node, true, false);
          case 126:
            return this.tsParseEnumDeclaration(node, {
              declare: true
            });
          case 112:
            return this.tsParseAmbientExternalModuleDeclaration(node);
          case 100:
            if (this.state.containsEsc) {
              return;
            }
          case 75:
          case 74:
            if (!this.match(75) || !this.isLookaheadContextual("enum")) {
              node.declare = true;
              return this.parseVarStatement(node, this.state.value, true);
            }
            this.expect(75);
            return this.tsParseEnumDeclaration(node, {
              const: true,
              declare: true
            });
          case 107:
            if (this.isUsing()) {
              this.raise(TSErrors.InvalidModifierOnUsingDeclaration, this.state.startLoc, "declare");
              node.declare = true;
              return this.parseVarStatement(node, "using", true);
            }
            break;
          case 96:
            if (this.isAwaitUsing()) {
              this.raise(TSErrors.InvalidModifierOnAwaitUsingDeclaration, this.state.startLoc, "declare");
              node.declare = true;
              this.next();
              return this.parseVarStatement(node, "await using", true);
            }
            break;
          case 129: {
            const result = this.tsParseInterfaceDeclaration(node, {
              declare: true
            });
            if (result)
              return result;
          }
          default:
            if (tokenIsIdentifier(startType)) {
              return this.tsParseDeclaration(node, this.state.type, true, null);
            }
        }
      });
    }
    tsTryParseExportDeclaration() {
      return this.tsParseDeclaration(this.startNode(), this.state.type, true, null);
    }
    tsParseDeclaration(node, type, next, decorators) {
      switch (type) {
        case 124:
          if (this.tsCheckLineTerminator(next) && (this.match(80) || tokenIsIdentifier(this.state.type))) {
            return this.tsParseAbstractDeclaration(node, decorators);
          }
          break;
        case 127:
          if (this.tsCheckLineTerminator(next)) {
            if (this.match(134)) {
              return this.tsParseAmbientExternalModuleDeclaration(node);
            } else if (tokenIsIdentifier(this.state.type)) {
              node.kind = "module";
              return this.tsParseModuleOrNamespaceDeclaration(node);
            }
          }
          break;
        case 128:
          if (this.tsCheckLineTerminator(next) && tokenIsIdentifier(this.state.type)) {
            node.kind = "namespace";
            return this.tsParseModuleOrNamespaceDeclaration(node);
          }
          break;
        case 130:
          if (this.tsCheckLineTerminator(next) && tokenIsIdentifier(this.state.type)) {
            return this.tsParseTypeAliasDeclaration(node);
          }
          break;
      }
    }
    tsCheckLineTerminator(next) {
      if (next) {
        if (this.hasFollowingLineBreak())
          return false;
        this.next();
        return true;
      }
      return !this.isLineTerminator();
    }
    tsTryParseGenericAsyncArrowFunction(startLoc) {
      if (!this.match(47))
        return;
      const oldMaybeInArrowParameters = this.state.maybeInArrowParameters;
      this.state.maybeInArrowParameters = true;
      const res = this.tsTryParseAndCatch(() => {
        const node = this.startNodeAt(startLoc);
        node.typeParameters = this.tsParseTypeParameters(this.tsParseConstModifier);
        super.parseFunctionParams(node);
        node.returnType = this.tsTryParseTypeOrTypePredicateAnnotation();
        this.expect(19);
        return node;
      });
      this.state.maybeInArrowParameters = oldMaybeInArrowParameters;
      if (!res)
        return;
      return super.parseArrowExpression(res, null, true);
    }
    tsParseTypeArgumentsInExpression() {
      if (this.reScan_lt() !== 47)
        return;
      return this.tsParseTypeArguments();
    }
    tsParseTypeArguments() {
      const node = this.startNode();
      node.params = this.tsInType(() => this.tsInTopLevelContext(() => {
        this.expect(47);
        return this.tsParseDelimitedList("TypeParametersOrArguments", this.tsParseType.bind(this));
      }));
      if (node.params.length === 0) {
        this.raise(TSErrors.EmptyTypeArguments, node);
      } else if (!this.state.inType && this.curContext() === types.brace) {
        this.reScan_lt_gt();
      }
      this.expect(48);
      return this.finishNode(node, "TSTypeParameterInstantiation");
    }
    tsIsDeclarationStart() {
      return tokenIsTSDeclarationStart(this.state.type);
    }
    isExportDefaultSpecifier() {
      if (this.tsIsDeclarationStart())
        return false;
      return super.isExportDefaultSpecifier();
    }
    parseBindingElement(flags, decorators) {
      const startLoc = decorators.length ? decorators[0].loc.start : this.state.startLoc;
      const modified = {};
      this.tsParseModifiers({
        allowedModifiers: ["public", "private", "protected", "override", "readonly"]
      }, modified);
      const accessibility = modified.accessibility;
      const override = modified.override;
      const readonly = modified.readonly;
      if (!(flags & 4) && (accessibility || readonly || override)) {
        this.raise(TSErrors.UnexpectedParameterModifier, startLoc);
      }
      const left = this.parseMaybeDefault();
      if (flags & 2) {
        this.parseFunctionParamType(left);
      }
      const elt = this.parseMaybeDefault(left.loc.start, left);
      if (accessibility || readonly || override) {
        const pp = this.startNodeAt(startLoc);
        if (decorators.length) {
          pp.decorators = decorators;
        }
        if (accessibility)
          pp.accessibility = accessibility;
        if (readonly)
          pp.readonly = readonly;
        if (override)
          pp.override = override;
        if (elt.type !== "Identifier" && elt.type !== "AssignmentPattern") {
          this.raise(TSErrors.UnsupportedParameterPropertyKind, pp);
        }
        pp.parameter = elt;
        return this.finishNode(pp, "TSParameterProperty");
      }
      if (decorators.length) {
        left.decorators = decorators;
      }
      return elt;
    }
    isSimpleParameter(node) {
      return node.type === "TSParameterProperty" && super.isSimpleParameter(node.parameter) || super.isSimpleParameter(node);
    }
    tsDisallowOptionalPattern(node) {
      for (const param of node.params) {
        if (param.type !== "Identifier" && param.optional && !this.state.isAmbientContext) {
          this.raise(TSErrors.PatternIsOptional, param);
        }
      }
    }
    setArrowFunctionParameters(node, params, trailingCommaLoc) {
      super.setArrowFunctionParameters(node, params, trailingCommaLoc);
      this.tsDisallowOptionalPattern(node);
    }
    parseFunctionBodyAndFinish(node, type, isMethod = false) {
      if (this.match(14)) {
        node.returnType = this.tsParseTypeOrTypePredicateAnnotation(14);
      }
      const bodilessType = type === "FunctionDeclaration" ? "TSDeclareFunction" : type === "ClassMethod" || type === "ClassPrivateMethod" ? "TSDeclareMethod" : undefined;
      if (bodilessType && !this.match(5) && this.isLineTerminator()) {
        return this.finishNode(node, bodilessType);
      }
      if (bodilessType === "TSDeclareFunction" && this.state.isAmbientContext) {
        this.raise(TSErrors.DeclareFunctionHasImplementation, node);
        if (node.declare) {
          return super.parseFunctionBodyAndFinish(node, bodilessType, isMethod);
        }
      }
      this.tsDisallowOptionalPattern(node);
      return super.parseFunctionBodyAndFinish(node, type, isMethod);
    }
    registerFunctionStatementId(node) {
      if (!node.body && node.id) {
        this.checkIdentifier(node.id, 1024);
      } else {
        super.registerFunctionStatementId(node);
      }
    }
    tsCheckForInvalidTypeCasts(items) {
      items.forEach((node) => {
        if ((node == null ? undefined : node.type) === "TSTypeCastExpression") {
          this.raise(TSErrors.UnexpectedTypeAnnotation, node.typeAnnotation);
        }
      });
    }
    toReferencedList(exprList, isInParens) {
      this.tsCheckForInvalidTypeCasts(exprList);
      return exprList;
    }
    parseArrayLike(close, isTuple, refExpressionErrors) {
      const node = super.parseArrayLike(close, isTuple, refExpressionErrors);
      if (node.type === "ArrayExpression") {
        this.tsCheckForInvalidTypeCasts(node.elements);
      }
      return node;
    }
    parseSubscript(base, startLoc, noCalls, state) {
      if (!this.hasPrecedingLineBreak() && this.match(35)) {
        this.state.canStartJSXElement = false;
        this.next();
        const nonNullExpression = this.startNodeAt(startLoc);
        nonNullExpression.expression = base;
        return this.finishNode(nonNullExpression, "TSNonNullExpression");
      }
      let isOptionalCall = false;
      if (this.match(18) && this.lookaheadCharCode() === 60) {
        if (noCalls) {
          state.stop = true;
          return base;
        }
        state.optionalChainMember = isOptionalCall = true;
        this.next();
      }
      if (this.match(47) || this.match(51)) {
        let missingParenErrorLoc;
        const result = this.tsTryParseAndCatch(() => {
          if (!noCalls && this.atPossibleAsyncArrow(base)) {
            const asyncArrowFn = this.tsTryParseGenericAsyncArrowFunction(startLoc);
            if (asyncArrowFn) {
              state.stop = true;
              return asyncArrowFn;
            }
          }
          const typeArguments = this.tsParseTypeArgumentsInExpression();
          if (!typeArguments)
            return;
          if (isOptionalCall && !this.match(10)) {
            missingParenErrorLoc = this.state.curPosition();
            return;
          }
          if (tokenIsTemplate(this.state.type)) {
            const result2 = super.parseTaggedTemplateExpression(base, startLoc, state);
            result2.typeParameters = typeArguments;
            return result2;
          }
          if (!noCalls && this.eat(10)) {
            const node2 = this.startNodeAt(startLoc);
            node2.callee = base;
            node2.arguments = this.parseCallExpressionArguments();
            this.tsCheckForInvalidTypeCasts(node2.arguments);
            node2.typeParameters = typeArguments;
            if (state.optionalChainMember) {
              node2.optional = isOptionalCall;
            }
            return this.finishCallExpression(node2, state.optionalChainMember);
          }
          const tokenType = this.state.type;
          if (tokenType === 48 || tokenType === 52 || tokenType !== 10 && tokenType !== 93 && tokenType !== 120 && tokenCanStartExpression(tokenType) && !this.hasPrecedingLineBreak()) {
            return;
          }
          const node = this.startNodeAt(startLoc);
          node.expression = base;
          node.typeParameters = typeArguments;
          return this.finishNode(node, "TSInstantiationExpression");
        });
        if (missingParenErrorLoc) {
          this.unexpected(missingParenErrorLoc, 10);
        }
        if (result) {
          if (result.type === "TSInstantiationExpression") {
            if (this.match(16) || this.match(18) && this.lookaheadCharCode() !== 40) {
              this.raise(TSErrors.InvalidPropertyAccessAfterInstantiationExpression, this.state.startLoc);
            }
            if (!this.match(16) && !this.match(18)) {
              result.expression = super.stopParseSubscript(base, state);
            }
          }
          return result;
        }
      }
      return super.parseSubscript(base, startLoc, noCalls, state);
    }
    parseNewCallee(node) {
      var _callee$extra;
      super.parseNewCallee(node);
      const {
        callee
      } = node;
      if (callee.type === "TSInstantiationExpression" && !((_callee$extra = callee.extra) != null && _callee$extra.parenthesized)) {
        node.typeParameters = callee.typeParameters;
        node.callee = callee.expression;
      }
    }
    parseExprOp(left, leftStartLoc, minPrec) {
      let isSatisfies;
      if (tokenOperatorPrecedence(58) > minPrec && !this.hasPrecedingLineBreak() && (this.isContextual(93) || (isSatisfies = this.isContextual(120)))) {
        const node = this.startNodeAt(leftStartLoc);
        node.expression = left;
        node.typeAnnotation = this.tsInType(() => {
          this.next();
          if (this.match(75)) {
            if (isSatisfies) {
              this.raise(Errors.UnexpectedKeyword, this.state.startLoc, {
                keyword: "const"
              });
            }
            return this.tsParseTypeReference();
          }
          return this.tsParseType();
        });
        this.finishNode(node, isSatisfies ? "TSSatisfiesExpression" : "TSAsExpression");
        this.reScan_lt_gt();
        return this.parseExprOp(node, leftStartLoc, minPrec);
      }
      return super.parseExprOp(left, leftStartLoc, minPrec);
    }
    checkReservedWord(word, startLoc, checkKeywords, isBinding) {
      if (!this.state.isAmbientContext) {
        super.checkReservedWord(word, startLoc, checkKeywords, isBinding);
      }
    }
    checkImportReflection(node) {
      super.checkImportReflection(node);
      if (node.module && node.importKind !== "value") {
        this.raise(TSErrors.ImportReflectionHasImportType, node.specifiers[0].loc.start);
      }
    }
    checkDuplicateExports() {}
    isPotentialImportPhase(isExport) {
      if (super.isPotentialImportPhase(isExport))
        return true;
      if (this.isContextual(130)) {
        const ch = this.lookaheadCharCode();
        return isExport ? ch === 123 || ch === 42 : ch !== 61;
      }
      return !isExport && this.isContextual(87);
    }
    applyImportPhase(node, isExport, phase, loc) {
      super.applyImportPhase(node, isExport, phase, loc);
      if (isExport) {
        node.exportKind = phase === "type" ? "type" : "value";
      } else {
        node.importKind = phase === "type" || phase === "typeof" ? phase : "value";
      }
    }
    parseImport(node) {
      if (this.match(134)) {
        node.importKind = "value";
        return super.parseImport(node);
      }
      let importNode;
      if (tokenIsIdentifier(this.state.type) && this.lookaheadCharCode() === 61) {
        node.importKind = "value";
        return this.tsParseImportEqualsDeclaration(node);
      } else if (this.isContextual(130)) {
        const maybeDefaultIdentifier = this.parseMaybeImportPhase(node, false);
        if (this.lookaheadCharCode() === 61) {
          return this.tsParseImportEqualsDeclaration(node, maybeDefaultIdentifier);
        } else {
          importNode = super.parseImportSpecifiersAndAfter(node, maybeDefaultIdentifier);
        }
      } else {
        importNode = super.parseImport(node);
      }
      if (importNode.importKind === "type" && importNode.specifiers.length > 1 && importNode.specifiers[0].type === "ImportDefaultSpecifier") {
        this.raise(TSErrors.TypeImportCannotSpecifyDefaultAndNamed, importNode);
      }
      return importNode;
    }
    parseExport(node, decorators) {
      if (this.match(83)) {
        const nodeImportEquals = node;
        this.next();
        let maybeDefaultIdentifier = null;
        if (this.isContextual(130) && this.isPotentialImportPhase(false)) {
          maybeDefaultIdentifier = this.parseMaybeImportPhase(nodeImportEquals, false);
        } else {
          nodeImportEquals.importKind = "value";
        }
        const declaration = this.tsParseImportEqualsDeclaration(nodeImportEquals, maybeDefaultIdentifier, true);
        return declaration;
      } else if (this.eat(29)) {
        const assign = node;
        assign.expression = super.parseExpression();
        this.semicolon();
        this.sawUnambiguousESM = true;
        return this.finishNode(assign, "TSExportAssignment");
      } else if (this.eatContextual(93)) {
        const decl = node;
        this.expectContextual(128);
        decl.id = this.parseIdentifier();
        this.semicolon();
        return this.finishNode(decl, "TSNamespaceExportDeclaration");
      } else {
        return super.parseExport(node, decorators);
      }
    }
    isAbstractClass() {
      return this.isContextual(124) && this.isLookaheadContextual("class");
    }
    parseExportDefaultExpression() {
      if (this.isAbstractClass()) {
        const cls = this.startNode();
        this.next();
        cls.abstract = true;
        return this.parseClass(cls, true, true);
      }
      if (this.match(129)) {
        const result = this.tsParseInterfaceDeclaration(this.startNode());
        if (result)
          return result;
      }
      return super.parseExportDefaultExpression();
    }
    parseVarStatement(node, kind, allowMissingInitializer = false) {
      const {
        isAmbientContext
      } = this.state;
      const declaration = super.parseVarStatement(node, kind, allowMissingInitializer || isAmbientContext);
      if (!isAmbientContext)
        return declaration;
      if (!node.declare && (kind === "using" || kind === "await using")) {
        this.raiseOverwrite(TSErrors.UsingDeclarationInAmbientContext, node, kind);
        return declaration;
      }
      for (const {
        id,
        init
      } of declaration.declarations) {
        if (!init)
          continue;
        if (kind === "var" || kind === "let" || !!id.typeAnnotation) {
          this.raise(TSErrors.InitializerNotAllowedInAmbientContext, init);
        } else if (!isValidAmbientConstInitializer(init, this.hasPlugin("estree"))) {
          this.raise(TSErrors.ConstInitializerMustBeStringOrNumericLiteralOrLiteralEnumReference, init);
        }
      }
      return declaration;
    }
    parseStatementContent(flags, decorators) {
      if (!this.state.containsEsc) {
        switch (this.state.type) {
          case 75: {
            if (this.isLookaheadContextual("enum")) {
              const node = this.startNode();
              this.expect(75);
              return this.tsParseEnumDeclaration(node, {
                const: true
              });
            }
            break;
          }
          case 124:
          case 125: {
            if (this.nextTokenIsIdentifierAndNotTSRelationalOperatorOnSameLine()) {
              const token = this.state.type;
              const node = this.startNode();
              this.next();
              const declaration = token === 125 ? this.tsTryParseDeclare(node) : this.tsParseAbstractDeclaration(node, decorators);
              if (declaration) {
                if (token === 125) {
                  declaration.declare = true;
                }
                return declaration;
              } else {
                node.expression = this.createIdentifier(this.startNodeAt(node.loc.start), token === 125 ? "declare" : "abstract");
                this.semicolon(false);
                return this.finishNode(node, "ExpressionStatement");
              }
            }
            break;
          }
          case 126:
            return this.tsParseEnumDeclaration(this.startNode());
          case 112: {
            const nextCh = this.lookaheadCharCode();
            if (nextCh === 123) {
              const node = this.startNode();
              return this.tsParseAmbientExternalModuleDeclaration(node);
            }
            break;
          }
          case 129: {
            const result = this.tsParseInterfaceDeclaration(this.startNode());
            if (result)
              return result;
            break;
          }
          case 127: {
            if (this.nextTokenIsIdentifierOrStringLiteralOnSameLine()) {
              const node = this.startNode();
              this.next();
              return this.tsParseDeclaration(node, 127, false, decorators);
            }
            break;
          }
          case 128: {
            if (this.nextTokenIsIdentifierOnSameLine()) {
              const node = this.startNode();
              this.next();
              return this.tsParseDeclaration(node, 128, false, decorators);
            }
            break;
          }
          case 130: {
            if (this.nextTokenIsIdentifierOnSameLine()) {
              const node = this.startNode();
              this.next();
              return this.tsParseTypeAliasDeclaration(node);
            }
            break;
          }
        }
      }
      return super.parseStatementContent(flags, decorators);
    }
    parseAccessModifier() {
      return this.tsParseModifier(["public", "protected", "private"]);
    }
    tsHasSomeModifiers(member, modifiers) {
      return modifiers.some((modifier) => {
        if (tsIsAccessModifier(modifier)) {
          return member.accessibility === modifier;
        }
        return !!member[modifier];
      });
    }
    tsIsStartOfStaticBlocks() {
      return this.isContextual(106) && this.lookaheadCharCode() === 123;
    }
    parseClassMember(classBody, member, state) {
      const modifiers = ["declare", "private", "public", "protected", "override", "abstract", "readonly", "static"];
      this.tsParseModifiers({
        allowedModifiers: modifiers,
        disallowedModifiers: ["in", "out"],
        stopOnStartOfClassStaticBlock: true,
        errorTemplate: TSErrors.InvalidModifierOnTypeParameterPositions
      }, member);
      const callParseClassMemberWithIsStatic = () => {
        if (this.tsIsStartOfStaticBlocks()) {
          this.next();
          this.next();
          if (this.tsHasSomeModifiers(member, modifiers)) {
            this.raise(TSErrors.StaticBlockCannotHaveModifier, this.state.curPosition());
          }
          super.parseClassStaticBlock(classBody, member);
        } else {
          this.parseClassMemberWithIsStatic(classBody, member, state, !!member.static);
        }
      };
      if (member.declare) {
        this.tsInAmbientContext(callParseClassMemberWithIsStatic);
      } else {
        callParseClassMemberWithIsStatic();
      }
    }
    parseClassMemberWithIsStatic(classBody, member, state, isStatic) {
      const idx = this.tsTryParseIndexSignature(member);
      if (idx) {
        classBody.body.push(idx);
        if (member.abstract) {
          this.raise(TSErrors.IndexSignatureHasAbstract, member);
        }
        if (member.accessibility) {
          this.raise(TSErrors.IndexSignatureHasAccessibility, member, {
            modifier: member.accessibility
          });
        }
        if (member.declare) {
          this.raise(TSErrors.IndexSignatureHasDeclare, member);
        }
        if (member.override) {
          this.raise(TSErrors.IndexSignatureHasOverride, member);
        }
        return;
      }
      if (!this.state.inAbstractClass && member.abstract) {
        this.raise(TSErrors.NonAbstractClassHasAbstractMethod, member);
      }
      if (member.override) {
        if (!state.hadSuperClass) {
          this.raise(TSErrors.OverrideNotInSubClass, member);
        }
      }
      super.parseClassMemberWithIsStatic(classBody, member, state, isStatic);
    }
    parsePostMemberNameModifiers(methodOrProp) {
      const optional = this.eat(17);
      if (optional)
        methodOrProp.optional = true;
      if (methodOrProp.readonly && this.match(10)) {
        this.raise(TSErrors.ClassMethodHasReadonly, methodOrProp);
      }
      if (methodOrProp.declare && this.match(10)) {
        this.raise(TSErrors.ClassMethodHasDeclare, methodOrProp);
      }
    }
    shouldParseExportDeclaration() {
      if (this.tsIsDeclarationStart())
        return true;
      return super.shouldParseExportDeclaration();
    }
    parseConditional(expr, startLoc, refExpressionErrors) {
      if (!this.match(17))
        return expr;
      if (this.state.maybeInArrowParameters) {
        const nextCh = this.lookaheadCharCode();
        if (nextCh === 44 || nextCh === 61 || nextCh === 58 || nextCh === 41) {
          this.setOptionalParametersError(refExpressionErrors);
          return expr;
        }
      }
      return super.parseConditional(expr, startLoc, refExpressionErrors);
    }
    parseParenItem(node, startLoc) {
      const newNode = super.parseParenItem(node, startLoc);
      if (this.eat(17)) {
        newNode.optional = true;
        this.resetEndLocation(node);
      }
      if (this.match(14)) {
        const typeCastNode = this.startNodeAt(startLoc);
        typeCastNode.expression = node;
        typeCastNode.typeAnnotation = this.tsParseTypeAnnotation();
        return this.finishNode(typeCastNode, "TSTypeCastExpression");
      }
      return node;
    }
    parseExportDeclaration(node) {
      if (!this.state.isAmbientContext && this.isContextual(125)) {
        return this.tsInAmbientContext(() => this.parseExportDeclaration(node));
      }
      const startLoc = this.state.startLoc;
      const isDeclare = this.eatContextual(125);
      if (isDeclare && (this.isContextual(125) || !this.shouldParseExportDeclaration())) {
        throw this.raise(TSErrors.ExpectedAmbientAfterExportDeclare, this.state.startLoc);
      }
      const isIdentifier = tokenIsIdentifier(this.state.type);
      const declaration = isIdentifier && this.tsTryParseExportDeclaration() || super.parseExportDeclaration(node);
      if (!declaration)
        return null;
      if (declaration.type === "TSInterfaceDeclaration" || declaration.type === "TSTypeAliasDeclaration" || isDeclare) {
        node.exportKind = "type";
      }
      if (isDeclare && declaration.type !== "TSImportEqualsDeclaration") {
        this.resetStartLocation(declaration, startLoc);
        declaration.declare = true;
      }
      return declaration;
    }
    parseClassId(node, isStatement, optionalId, bindingType) {
      if ((!isStatement || optionalId) && this.isContextual(113)) {
        return;
      }
      super.parseClassId(node, isStatement, optionalId, node.declare ? 1024 : 8331);
      const typeParameters = this.tsTryParseTypeParameters(this.tsParseInOutConstModifiers);
      if (typeParameters)
        node.typeParameters = typeParameters;
    }
    parseClassPropertyAnnotation(node) {
      if (!node.optional) {
        if (this.eat(35)) {
          node.definite = true;
        } else if (this.eat(17)) {
          node.optional = true;
        }
      }
      const type = this.tsTryParseTypeAnnotation();
      if (type)
        node.typeAnnotation = type;
    }
    parseClassProperty(node) {
      this.parseClassPropertyAnnotation(node);
      if (this.state.isAmbientContext && !(node.readonly && !node.typeAnnotation) && this.match(29)) {
        this.raise(TSErrors.DeclareClassFieldHasInitializer, this.state.startLoc);
      }
      if (node.abstract && this.match(29)) {
        const {
          key
        } = node;
        this.raise(TSErrors.AbstractPropertyHasInitializer, this.state.startLoc, {
          propertyName: key.type === "Identifier" && !node.computed ? key.name : `[${this.input.slice(this.offsetToSourcePos(key.start), this.offsetToSourcePos(key.end))}]`
        });
      }
      return super.parseClassProperty(node);
    }
    parseClassPrivateProperty(node) {
      if (node.abstract) {
        this.raise(TSErrors.PrivateElementHasAbstract, node);
      }
      if (node.accessibility) {
        this.raise(TSErrors.PrivateElementHasAccessibility, node, {
          modifier: node.accessibility
        });
      }
      this.parseClassPropertyAnnotation(node);
      return super.parseClassPrivateProperty(node);
    }
    parseClassAccessorProperty(node) {
      this.parseClassPropertyAnnotation(node);
      if (node.optional) {
        this.raise(TSErrors.AccessorCannotBeOptional, node);
      }
      return super.parseClassAccessorProperty(node);
    }
    pushClassMethod(classBody, method, isGenerator, isAsync, isConstructor, allowsDirectSuper) {
      const typeParameters = this.tsTryParseTypeParameters(this.tsParseConstModifier);
      if (typeParameters && isConstructor) {
        this.raise(TSErrors.ConstructorHasTypeParameters, typeParameters);
      }
      const {
        declare = false,
        kind
      } = method;
      if (declare && (kind === "get" || kind === "set")) {
        this.raise(TSErrors.DeclareAccessor, method, {
          kind
        });
      }
      if (typeParameters)
        method.typeParameters = typeParameters;
      super.pushClassMethod(classBody, method, isGenerator, isAsync, isConstructor, allowsDirectSuper);
    }
    pushClassPrivateMethod(classBody, method, isGenerator, isAsync) {
      const typeParameters = this.tsTryParseTypeParameters(this.tsParseConstModifier);
      if (typeParameters)
        method.typeParameters = typeParameters;
      super.pushClassPrivateMethod(classBody, method, isGenerator, isAsync);
    }
    declareClassPrivateMethodInScope(node, kind) {
      if (node.type === "TSDeclareMethod")
        return;
      if (node.type === "MethodDefinition" && node.value.body == null) {
        return;
      }
      super.declareClassPrivateMethodInScope(node, kind);
    }
    parseClassSuper(node) {
      super.parseClassSuper(node);
      if (node.superClass) {
        if (node.superClass.type === "TSInstantiationExpression") {
          const tsInstantiationExpression = node.superClass;
          const superClass2 = tsInstantiationExpression.expression;
          this.takeSurroundingComments(superClass2, superClass2.start, superClass2.end);
          const superTypeArguments = tsInstantiationExpression.typeParameters;
          this.takeSurroundingComments(superTypeArguments, superTypeArguments.start, superTypeArguments.end);
          node.superClass = superClass2;
          node.superTypeParameters = superTypeArguments;
        } else if (this.match(47) || this.match(51)) {
          node.superTypeParameters = this.tsParseTypeArgumentsInExpression();
        }
      }
      if (this.eatContextual(113)) {
        node.implements = this.tsParseHeritageClause("implements");
      }
    }
    parseObjPropValue(prop, startLoc, isGenerator, isAsync, isPattern, isAccessor, refExpressionErrors) {
      const typeParameters = this.tsTryParseTypeParameters(this.tsParseConstModifier);
      if (typeParameters)
        prop.typeParameters = typeParameters;
      return super.parseObjPropValue(prop, startLoc, isGenerator, isAsync, isPattern, isAccessor, refExpressionErrors);
    }
    parseFunctionParams(node, isConstructor) {
      const typeParameters = this.tsTryParseTypeParameters(this.tsParseConstModifier);
      if (typeParameters)
        node.typeParameters = typeParameters;
      super.parseFunctionParams(node, isConstructor);
    }
    parseVarId(decl, kind) {
      super.parseVarId(decl, kind);
      if (decl.id.type === "Identifier" && !this.hasPrecedingLineBreak() && this.eat(35)) {
        decl.definite = true;
      }
      const type = this.tsTryParseTypeAnnotation();
      if (type) {
        decl.id.typeAnnotation = type;
        this.resetEndLocation(decl.id);
      }
    }
    parseAsyncArrowFromCallExpression(node, call) {
      if (this.match(14)) {
        node.returnType = this.tsParseTypeAnnotation();
      }
      return super.parseAsyncArrowFromCallExpression(node, call);
    }
    parseMaybeAssign(refExpressionErrors, afterLeftParse) {
      var _jsx, _jsx2, _typeCast, _jsx3, _typeCast2;
      let state;
      let jsx2;
      let typeCast;
      if (this.hasPlugin("jsx") && (this.match(143) || this.match(47))) {
        state = this.state.clone();
        jsx2 = this.tryParse(() => super.parseMaybeAssign(refExpressionErrors, afterLeftParse), state);
        if (!jsx2.error)
          return jsx2.node;
        const {
          context
        } = this.state;
        const currentContext = context[context.length - 1];
        if (currentContext === types.j_oTag || currentContext === types.j_expr) {
          context.pop();
        }
      }
      if (!((_jsx = jsx2) != null && _jsx.error) && !this.match(47)) {
        return super.parseMaybeAssign(refExpressionErrors, afterLeftParse);
      }
      if (!state || state === this.state)
        state = this.state.clone();
      let typeParameters;
      const arrow = this.tryParse((abort) => {
        var _expr$extra, _typeParameters;
        typeParameters = this.tsParseTypeParameters(this.tsParseConstModifier);
        const expr = super.parseMaybeAssign(refExpressionErrors, afterLeftParse);
        if (expr.type !== "ArrowFunctionExpression" || (_expr$extra = expr.extra) != null && _expr$extra.parenthesized) {
          abort();
        }
        if (((_typeParameters = typeParameters) == null ? undefined : _typeParameters.params.length) !== 0) {
          this.resetStartLocationFromNode(expr, typeParameters);
        }
        expr.typeParameters = typeParameters;
        return expr;
      }, state);
      if (!arrow.error && !arrow.aborted) {
        if (typeParameters)
          this.reportReservedArrowTypeParam(typeParameters);
        return arrow.node;
      }
      if (!jsx2) {
        assert(!this.hasPlugin("jsx"));
        typeCast = this.tryParse(() => super.parseMaybeAssign(refExpressionErrors, afterLeftParse), state);
        if (!typeCast.error)
          return typeCast.node;
      }
      if ((_jsx2 = jsx2) != null && _jsx2.node) {
        this.state = jsx2.failState;
        return jsx2.node;
      }
      if (arrow.node) {
        this.state = arrow.failState;
        if (typeParameters)
          this.reportReservedArrowTypeParam(typeParameters);
        return arrow.node;
      }
      if ((_typeCast = typeCast) != null && _typeCast.node) {
        this.state = typeCast.failState;
        return typeCast.node;
      }
      throw ((_jsx3 = jsx2) == null ? undefined : _jsx3.error) || arrow.error || ((_typeCast2 = typeCast) == null ? undefined : _typeCast2.error);
    }
    reportReservedArrowTypeParam(node) {
      var _node$extra2;
      if (node.params.length === 1 && !node.params[0].constraint && !((_node$extra2 = node.extra) != null && _node$extra2.trailingComma) && this.getPluginOption("typescript", "disallowAmbiguousJSXLike")) {
        this.raise(TSErrors.ReservedArrowTypeParam, node);
      }
    }
    parseMaybeUnary(refExpressionErrors, sawUnary) {
      if (!this.hasPlugin("jsx") && this.match(47)) {
        return this.tsParseTypeAssertion();
      }
      return super.parseMaybeUnary(refExpressionErrors, sawUnary);
    }
    parseArrow(node) {
      if (this.match(14)) {
        const result = this.tryParse((abort) => {
          const returnType = this.tsParseTypeOrTypePredicateAnnotation(14);
          if (this.canInsertSemicolon() || !this.match(19))
            abort();
          return returnType;
        });
        if (result.aborted)
          return;
        if (!result.thrown) {
          if (result.error)
            this.state = result.failState;
          node.returnType = result.node;
        }
      }
      return super.parseArrow(node);
    }
    parseFunctionParamType(param) {
      if (this.eat(17)) {
        param.optional = true;
      }
      const type = this.tsTryParseTypeAnnotation();
      if (type)
        param.typeAnnotation = type;
      this.resetEndLocation(param);
      return param;
    }
    isAssignable(node, isBinding) {
      switch (node.type) {
        case "TSTypeCastExpression":
          return this.isAssignable(node.expression, isBinding);
        case "TSParameterProperty":
          return true;
        default:
          return super.isAssignable(node, isBinding);
      }
    }
    toAssignable(node, isLHS = false) {
      switch (node.type) {
        case "ParenthesizedExpression":
          this.toAssignableParenthesizedExpression(node, isLHS);
          break;
        case "TSAsExpression":
        case "TSSatisfiesExpression":
        case "TSNonNullExpression":
        case "TSTypeAssertion":
          if (isLHS) {
            this.expressionScope.recordArrowParameterBindingError(TSErrors.UnexpectedTypeCastInParameter, node);
          } else {
            this.raise(TSErrors.UnexpectedTypeCastInParameter, node);
          }
          this.toAssignable(node.expression, isLHS);
          break;
        case "AssignmentExpression":
          if (!isLHS && node.left.type === "TSTypeCastExpression") {
            node.left = this.typeCastToParameter(node.left);
          }
        default:
          super.toAssignable(node, isLHS);
      }
    }
    toAssignableParenthesizedExpression(node, isLHS) {
      switch (node.expression.type) {
        case "TSAsExpression":
        case "TSSatisfiesExpression":
        case "TSNonNullExpression":
        case "TSTypeAssertion":
        case "ParenthesizedExpression":
          this.toAssignable(node.expression, isLHS);
          break;
        default:
          super.toAssignable(node, isLHS);
      }
    }
    checkToRestConversion(node, allowPattern) {
      switch (node.type) {
        case "TSAsExpression":
        case "TSSatisfiesExpression":
        case "TSTypeAssertion":
        case "TSNonNullExpression":
          this.checkToRestConversion(node.expression, false);
          break;
        default:
          super.checkToRestConversion(node, allowPattern);
      }
    }
    isValidLVal(type, disallowCallExpression, isUnparenthesizedInAssign, binding) {
      switch (type) {
        case "TSTypeCastExpression":
          return true;
        case "TSParameterProperty":
          return "parameter";
        case "TSNonNullExpression":
          return "expression";
        case "TSAsExpression":
        case "TSSatisfiesExpression":
        case "TSTypeAssertion":
          return (binding !== 64 || !isUnparenthesizedInAssign) && ["expression", true];
        default:
          return super.isValidLVal(type, disallowCallExpression, isUnparenthesizedInAssign, binding);
      }
    }
    parseBindingAtom() {
      if (this.state.type === 78) {
        return this.parseIdentifier(true);
      }
      return super.parseBindingAtom();
    }
    parseMaybeDecoratorArguments(expr, startLoc) {
      if (this.match(47) || this.match(51)) {
        const typeArguments = this.tsParseTypeArgumentsInExpression();
        if (this.match(10)) {
          const call = super.parseMaybeDecoratorArguments(expr, startLoc);
          call.typeParameters = typeArguments;
          return call;
        }
        this.unexpected(null, 10);
      }
      return super.parseMaybeDecoratorArguments(expr, startLoc);
    }
    checkCommaAfterRest(close) {
      if (this.state.isAmbientContext && this.match(12) && this.lookaheadCharCode() === close) {
        this.next();
        return false;
      }
      return super.checkCommaAfterRest(close);
    }
    isClassMethod() {
      return this.match(47) || super.isClassMethod();
    }
    isClassProperty() {
      return this.match(35) || this.match(14) || super.isClassProperty();
    }
    parseMaybeDefault(startLoc, left) {
      const node = super.parseMaybeDefault(startLoc, left);
      if (node.type === "AssignmentPattern" && node.typeAnnotation && node.right.start < node.typeAnnotation.start) {
        this.raise(TSErrors.TypeAnnotationAfterAssign, node.typeAnnotation);
      }
      return node;
    }
    getTokenFromCode(code2) {
      if (this.state.inType) {
        if (code2 === 62) {
          this.finishOp(48, 1);
          return;
        }
        if (code2 === 60) {
          this.finishOp(47, 1);
          return;
        }
      }
      super.getTokenFromCode(code2);
    }
    reScan_lt_gt() {
      const {
        type
      } = this.state;
      if (type === 47) {
        this.state.pos -= 1;
        this.readToken_lt();
      } else if (type === 48) {
        this.state.pos -= 1;
        this.readToken_gt();
      }
    }
    reScan_lt() {
      const {
        type
      } = this.state;
      if (type === 51) {
        this.state.pos -= 2;
        this.finishOp(47, 1);
        return 47;
      }
      return type;
    }
    toAssignableListItem(exprList, index, isLHS) {
      const node = exprList[index];
      if (node.type === "TSTypeCastExpression") {
        exprList[index] = this.typeCastToParameter(node);
      }
      super.toAssignableListItem(exprList, index, isLHS);
    }
    typeCastToParameter(node) {
      node.expression.typeAnnotation = node.typeAnnotation;
      this.resetEndLocation(node.expression, node.typeAnnotation.loc.end);
      return node.expression;
    }
    shouldParseArrow(params) {
      if (this.match(14)) {
        return params.every((expr) => this.isAssignable(expr, true));
      }
      return super.shouldParseArrow(params);
    }
    shouldParseAsyncArrow() {
      return this.match(14) || super.shouldParseAsyncArrow();
    }
    canHaveLeadingDecorator() {
      return super.canHaveLeadingDecorator() || this.isAbstractClass();
    }
    jsxParseOpeningElementAfterName(node) {
      if (this.match(47) || this.match(51)) {
        const typeArguments = this.tsTryParseAndCatch(() => this.tsParseTypeArgumentsInExpression());
        if (typeArguments) {
          node.typeParameters = typeArguments;
        }
      }
      return super.jsxParseOpeningElementAfterName(node);
    }
    getGetterSetterExpectedParamCount(method) {
      const baseCount = super.getGetterSetterExpectedParamCount(method);
      const params = this.getObjectOrClassMethodParams(method);
      const firstParam = params[0];
      const hasContextParam = firstParam && this.isThisParam(firstParam);
      return hasContextParam ? baseCount + 1 : baseCount;
    }
    parseCatchClauseParam() {
      const param = super.parseCatchClauseParam();
      const type = this.tsTryParseTypeAnnotation();
      if (type) {
        param.typeAnnotation = type;
        this.resetEndLocation(param);
      }
      return param;
    }
    tsInAmbientContext(cb) {
      const {
        isAmbientContext: oldIsAmbientContext,
        strict: oldStrict
      } = this.state;
      this.state.isAmbientContext = true;
      this.state.strict = false;
      try {
        return cb();
      } finally {
        this.state.isAmbientContext = oldIsAmbientContext;
        this.state.strict = oldStrict;
      }
    }
    parseClass(node, isStatement, optionalId) {
      const oldInAbstractClass = this.state.inAbstractClass;
      this.state.inAbstractClass = !!node.abstract;
      try {
        return super.parseClass(node, isStatement, optionalId);
      } finally {
        this.state.inAbstractClass = oldInAbstractClass;
      }
    }
    tsParseAbstractDeclaration(node, decorators) {
      if (this.match(80)) {
        node.abstract = true;
        return this.maybeTakeDecorators(decorators, this.parseClass(node, true, false));
      } else if (this.isContextual(129)) {
        if (!this.hasFollowingLineBreak()) {
          node.abstract = true;
          this.raise(TSErrors.NonClassMethodPropertyHasAbstractModifier, node);
          return this.tsParseInterfaceDeclaration(node);
        } else {
          return null;
        }
      }
      throw this.unexpected(null, 80);
    }
    parseMethod(node, isGenerator, isAsync, isConstructor, allowDirectSuper, type, inClassScope) {
      const method = super.parseMethod(node, isGenerator, isAsync, isConstructor, allowDirectSuper, type, inClassScope);
      if (method.abstract || method.type === "TSAbstractMethodDefinition") {
        const hasEstreePlugin = this.hasPlugin("estree");
        const methodFn = hasEstreePlugin ? method.value : method;
        if (methodFn.body) {
          const {
            key
          } = method;
          this.raise(TSErrors.AbstractMethodHasImplementation, method, {
            methodName: key.type === "Identifier" && !method.computed ? key.name : `[${this.input.slice(this.offsetToSourcePos(key.start), this.offsetToSourcePos(key.end))}]`
          });
        }
      }
      return method;
    }
    tsParseTypeParameterName() {
      const typeName = this.parseIdentifier();
      return typeName.name;
    }
    shouldParseAsAmbientContext() {
      return !!this.getPluginOption("typescript", "dts");
    }
    parse() {
      if (this.shouldParseAsAmbientContext()) {
        this.state.isAmbientContext = true;
      }
      return super.parse();
    }
    getExpression() {
      if (this.shouldParseAsAmbientContext()) {
        this.state.isAmbientContext = true;
      }
      return super.getExpression();
    }
    parseExportSpecifier(node, isString, isInTypeExport, isMaybeTypeOnly) {
      if (!isString && isMaybeTypeOnly) {
        this.parseTypeOnlyImportExportSpecifier(node, false, isInTypeExport);
        return this.finishNode(node, "ExportSpecifier");
      }
      node.exportKind = "value";
      return super.parseExportSpecifier(node, isString, isInTypeExport, isMaybeTypeOnly);
    }
    parseImportSpecifier(specifier, importedIsString, isInTypeOnlyImport, isMaybeTypeOnly, bindingType) {
      if (!importedIsString && isMaybeTypeOnly) {
        this.parseTypeOnlyImportExportSpecifier(specifier, true, isInTypeOnlyImport);
        return this.finishNode(specifier, "ImportSpecifier");
      }
      specifier.importKind = "value";
      return super.parseImportSpecifier(specifier, importedIsString, isInTypeOnlyImport, isMaybeTypeOnly, isInTypeOnlyImport ? 4098 : 4096);
    }
    parseTypeOnlyImportExportSpecifier(node, isImport, isInTypeOnlyImportExport) {
      const leftOfAsKey = isImport ? "imported" : "local";
      const rightOfAsKey = isImport ? "local" : "exported";
      let leftOfAs = node[leftOfAsKey];
      let rightOfAs;
      let hasTypeSpecifier = false;
      let canParseAsKeyword = true;
      const loc = leftOfAs.loc.start;
      if (this.isContextual(93)) {
        const firstAs = this.parseIdentifier();
        if (this.isContextual(93)) {
          const secondAs = this.parseIdentifier();
          if (tokenIsKeywordOrIdentifier(this.state.type)) {
            hasTypeSpecifier = true;
            leftOfAs = firstAs;
            rightOfAs = isImport ? this.parseIdentifier() : this.parseModuleExportName();
            canParseAsKeyword = false;
          } else {
            rightOfAs = secondAs;
            canParseAsKeyword = false;
          }
        } else if (tokenIsKeywordOrIdentifier(this.state.type)) {
          canParseAsKeyword = false;
          rightOfAs = isImport ? this.parseIdentifier() : this.parseModuleExportName();
        } else {
          hasTypeSpecifier = true;
          leftOfAs = firstAs;
        }
      } else if (tokenIsKeywordOrIdentifier(this.state.type)) {
        hasTypeSpecifier = true;
        if (isImport) {
          leftOfAs = this.parseIdentifier(true);
          if (!this.isContextual(93)) {
            this.checkReservedWord(leftOfAs.name, leftOfAs.loc.start, true, true);
          }
        } else {
          leftOfAs = this.parseModuleExportName();
        }
      }
      if (hasTypeSpecifier && isInTypeOnlyImportExport) {
        this.raise(isImport ? TSErrors.TypeModifierIsUsedInTypeImports : TSErrors.TypeModifierIsUsedInTypeExports, loc);
      }
      node[leftOfAsKey] = leftOfAs;
      node[rightOfAsKey] = rightOfAs;
      const kindKey = isImport ? "importKind" : "exportKind";
      node[kindKey] = hasTypeSpecifier ? "type" : "value";
      if (canParseAsKeyword && this.eatContextual(93)) {
        node[rightOfAsKey] = isImport ? this.parseIdentifier() : this.parseModuleExportName();
      }
      if (!node[rightOfAsKey]) {
        node[rightOfAsKey] = this.cloneIdentifier(node[leftOfAsKey]);
      }
      if (isImport) {
        this.checkIdentifier(node[rightOfAsKey], hasTypeSpecifier ? 4098 : 4096);
      }
    }
    fillOptionalPropertiesForTSESLint(node) {
      var _node$directive, _node$decorators, _node$optional, _node$typeAnnotation, _node$accessibility, _node$decorators2, _node$override, _node$readonly, _node$static, _node$declare, _node$returnType, _node$typeParameters, _node$optional2, _node$optional3, _node$accessibility2, _node$readonly2, _node$static2, _node$declare2, _node$definite, _node$readonly3, _node$typeAnnotation2, _node$accessibility3, _node$decorators3, _node$override2, _node$optional4, _node$id, _node$abstract, _node$declare3, _node$decorators4, _node$implements, _node$superTypeArgume, _node$typeParameters2, _node$declare4, _node$definite2, _node$const, _node$declare5, _node$computed, _node$qualifier, _node$options, _node$declare6, _node$extends, _node$optional5, _node$readonly4, _node$declare7, _node$global, _node$const2, _node$in, _node$out;
      switch (node.type) {
        case "ExpressionStatement":
          (_node$directive = node.directive) != null || (node.directive = undefined);
          return;
        case "RestElement":
          node.value = undefined;
        case "Identifier":
        case "ArrayPattern":
        case "AssignmentPattern":
        case "ObjectPattern":
          (_node$decorators = node.decorators) != null || (node.decorators = []);
          (_node$optional = node.optional) != null || (node.optional = false);
          (_node$typeAnnotation = node.typeAnnotation) != null || (node.typeAnnotation = undefined);
          return;
        case "TSParameterProperty":
          (_node$accessibility = node.accessibility) != null || (node.accessibility = undefined);
          (_node$decorators2 = node.decorators) != null || (node.decorators = []);
          (_node$override = node.override) != null || (node.override = false);
          (_node$readonly = node.readonly) != null || (node.readonly = false);
          (_node$static = node.static) != null || (node.static = false);
          return;
        case "TSEmptyBodyFunctionExpression":
          node.body = null;
        case "TSDeclareFunction":
        case "FunctionDeclaration":
        case "FunctionExpression":
        case "ClassMethod":
        case "ClassPrivateMethod":
          (_node$declare = node.declare) != null || (node.declare = false);
          (_node$returnType = node.returnType) != null || (node.returnType = undefined);
          (_node$typeParameters = node.typeParameters) != null || (node.typeParameters = undefined);
          return;
        case "Property":
          (_node$optional2 = node.optional) != null || (node.optional = false);
          return;
        case "TSMethodSignature":
        case "TSPropertySignature":
          (_node$optional3 = node.optional) != null || (node.optional = false);
        case "TSIndexSignature":
          (_node$accessibility2 = node.accessibility) != null || (node.accessibility = undefined);
          (_node$readonly2 = node.readonly) != null || (node.readonly = false);
          (_node$static2 = node.static) != null || (node.static = false);
          return;
        case "TSAbstractPropertyDefinition":
        case "PropertyDefinition":
        case "TSAbstractAccessorProperty":
        case "AccessorProperty":
          (_node$declare2 = node.declare) != null || (node.declare = false);
          (_node$definite = node.definite) != null || (node.definite = false);
          (_node$readonly3 = node.readonly) != null || (node.readonly = false);
          (_node$typeAnnotation2 = node.typeAnnotation) != null || (node.typeAnnotation = undefined);
        case "TSAbstractMethodDefinition":
        case "MethodDefinition":
          (_node$accessibility3 = node.accessibility) != null || (node.accessibility = undefined);
          (_node$decorators3 = node.decorators) != null || (node.decorators = []);
          (_node$override2 = node.override) != null || (node.override = false);
          (_node$optional4 = node.optional) != null || (node.optional = false);
          return;
        case "ClassExpression":
          (_node$id = node.id) != null || (node.id = null);
        case "ClassDeclaration":
          (_node$abstract = node.abstract) != null || (node.abstract = false);
          (_node$declare3 = node.declare) != null || (node.declare = false);
          (_node$decorators4 = node.decorators) != null || (node.decorators = []);
          (_node$implements = node.implements) != null || (node.implements = []);
          (_node$superTypeArgume = node.superTypeArguments) != null || (node.superTypeArguments = undefined);
          (_node$typeParameters2 = node.typeParameters) != null || (node.typeParameters = undefined);
          return;
        case "TSTypeAliasDeclaration":
        case "VariableDeclaration":
          (_node$declare4 = node.declare) != null || (node.declare = false);
          return;
        case "VariableDeclarator":
          (_node$definite2 = node.definite) != null || (node.definite = false);
          return;
        case "TSEnumDeclaration":
          (_node$const = node.const) != null || (node.const = false);
          (_node$declare5 = node.declare) != null || (node.declare = false);
          return;
        case "TSEnumMember":
          (_node$computed = node.computed) != null || (node.computed = false);
          return;
        case "TSImportType":
          (_node$qualifier = node.qualifier) != null || (node.qualifier = null);
          (_node$options = node.options) != null || (node.options = null);
          return;
        case "TSInterfaceDeclaration":
          (_node$declare6 = node.declare) != null || (node.declare = false);
          (_node$extends = node.extends) != null || (node.extends = []);
          return;
        case "TSMappedType":
          (_node$optional5 = node.optional) != null || (node.optional = false);
          (_node$readonly4 = node.readonly) != null || (node.readonly = undefined);
          return;
        case "TSModuleDeclaration":
          (_node$declare7 = node.declare) != null || (node.declare = false);
          (_node$global = node.global) != null || (node.global = node.kind === "global");
          return;
        case "TSTypeParameter":
          (_node$const2 = node.const) != null || (node.const = false);
          (_node$in = node.in) != null || (node.in = false);
          (_node$out = node.out) != null || (node.out = false);
          return;
      }
    }
    chStartsBindingIdentifierAndNotRelationalOperator(ch, pos) {
      if (isIdentifierStart(ch)) {
        keywordAndTSRelationalOperator.lastIndex = pos;
        if (keywordAndTSRelationalOperator.test(this.input)) {
          const endCh = this.codePointAtPos(keywordAndTSRelationalOperator.lastIndex);
          if (!isIdentifierChar(endCh) && endCh !== 92) {
            return false;
          }
        }
        return true;
      } else if (ch === 92) {
        return true;
      } else {
        return false;
      }
    }
    nextTokenIsIdentifierAndNotTSRelationalOperatorOnSameLine() {
      const next = this.nextTokenInLineStart();
      const nextCh = this.codePointAtPos(next);
      return this.chStartsBindingIdentifierAndNotRelationalOperator(nextCh, next);
    }
    nextTokenIsIdentifierOrStringLiteralOnSameLine() {
      const next = this.nextTokenInLineStart();
      const nextCh = this.codePointAtPos(next);
      return this.chStartsBindingIdentifier(nextCh, next) || nextCh === 34 || nextCh === 39;
    }
  };
  function isPossiblyLiteralEnum(expression) {
    if (expression.type !== "MemberExpression")
      return false;
    const {
      computed,
      property
    } = expression;
    if (computed && property.type !== "StringLiteral" && (property.type !== "TemplateLiteral" || property.expressions.length > 0)) {
      return false;
    }
    return isUncomputedMemberExpressionChain(expression.object);
  }
  function isValidAmbientConstInitializer(expression, estree2) {
    var _expression$extra;
    const {
      type
    } = expression;
    if ((_expression$extra = expression.extra) != null && _expression$extra.parenthesized) {
      return false;
    }
    if (estree2) {
      if (type === "Literal") {
        const {
          value
        } = expression;
        if (typeof value === "string" || typeof value === "boolean") {
          return true;
        }
      }
    } else {
      if (type === "StringLiteral" || type === "BooleanLiteral") {
        return true;
      }
    }
    if (isNumber(expression, estree2) || isNegativeNumber(expression, estree2)) {
      return true;
    }
    if (type === "TemplateLiteral" && expression.expressions.length === 0) {
      return true;
    }
    if (isPossiblyLiteralEnum(expression)) {
      return true;
    }
    return false;
  }
  function isNumber(expression, estree2) {
    if (estree2) {
      return expression.type === "Literal" && (typeof expression.value === "number" || ("bigint" in expression));
    }
    return expression.type === "NumericLiteral" || expression.type === "BigIntLiteral";
  }
  function isNegativeNumber(expression, estree2) {
    if (expression.type === "UnaryExpression") {
      const {
        operator,
        argument
      } = expression;
      if (operator === "-" && isNumber(argument, estree2)) {
        return true;
      }
    }
    return false;
  }
  function isUncomputedMemberExpressionChain(expression) {
    if (expression.type === "Identifier")
      return true;
    if (expression.type !== "MemberExpression" || expression.computed) {
      return false;
    }
    return isUncomputedMemberExpressionChain(expression.object);
  }
  var PlaceholderErrors = ParseErrorEnum`placeholders`({
    ClassNameIsRequired: "A class name is required.",
    UnexpectedSpace: "Unexpected space in placeholder."
  });
  var placeholders = (superClass) => class PlaceholdersParserMixin extends superClass {
    parsePlaceholder(expectedNode) {
      if (this.match(133)) {
        const node = this.startNode();
        this.next();
        this.assertNoSpace();
        node.name = super.parseIdentifier(true);
        this.assertNoSpace();
        this.expect(133);
        return this.finishPlaceholder(node, expectedNode);
      }
    }
    finishPlaceholder(node, expectedNode) {
      let placeholder = node;
      if (!placeholder.expectedNode || !placeholder.type) {
        placeholder = this.finishNode(placeholder, "Placeholder");
      }
      placeholder.expectedNode = expectedNode;
      return placeholder;
    }
    getTokenFromCode(code2) {
      if (code2 === 37 && this.input.charCodeAt(this.state.pos + 1) === 37) {
        this.finishOp(133, 2);
      } else {
        super.getTokenFromCode(code2);
      }
    }
    parseExprAtom(refExpressionErrors) {
      return this.parsePlaceholder("Expression") || super.parseExprAtom(refExpressionErrors);
    }
    parseIdentifier(liberal) {
      return this.parsePlaceholder("Identifier") || super.parseIdentifier(liberal);
    }
    checkReservedWord(word, startLoc, checkKeywords, isBinding) {
      if (word !== undefined) {
        super.checkReservedWord(word, startLoc, checkKeywords, isBinding);
      }
    }
    cloneIdentifier(node) {
      const cloned = super.cloneIdentifier(node);
      if (cloned.type === "Placeholder") {
        cloned.expectedNode = node.expectedNode;
      }
      return cloned;
    }
    cloneStringLiteral(node) {
      if (node.type === "Placeholder") {
        return this.cloneIdentifier(node);
      }
      return super.cloneStringLiteral(node);
    }
    parseBindingAtom() {
      return this.parsePlaceholder("Pattern") || super.parseBindingAtom();
    }
    isValidLVal(type, disallowCallExpression, isParenthesized, binding) {
      return type === "Placeholder" || super.isValidLVal(type, disallowCallExpression, isParenthesized, binding);
    }
    toAssignable(node, isLHS) {
      if (node && node.type === "Placeholder" && node.expectedNode === "Expression") {
        node.expectedNode = "Pattern";
      } else {
        super.toAssignable(node, isLHS);
      }
    }
    chStartsBindingIdentifier(ch, pos) {
      if (super.chStartsBindingIdentifier(ch, pos)) {
        return true;
      }
      const next = this.nextTokenStart();
      if (this.input.charCodeAt(next) === 37 && this.input.charCodeAt(next + 1) === 37) {
        return true;
      }
      return false;
    }
    verifyBreakContinue(node, isBreak) {
      var _node$label;
      if (((_node$label = node.label) == null ? undefined : _node$label.type) === "Placeholder")
        return;
      super.verifyBreakContinue(node, isBreak);
    }
    parseExpressionStatement(node, expr) {
      var _expr$extra;
      if (expr.type !== "Placeholder" || (_expr$extra = expr.extra) != null && _expr$extra.parenthesized) {
        return super.parseExpressionStatement(node, expr);
      }
      if (this.match(14)) {
        const stmt = node;
        stmt.label = this.finishPlaceholder(expr, "Identifier");
        this.next();
        stmt.body = super.parseStatementOrSloppyAnnexBFunctionDeclaration();
        return this.finishNode(stmt, "LabeledStatement");
      }
      this.semicolon();
      const stmtPlaceholder = node;
      stmtPlaceholder.name = expr.name;
      return this.finishPlaceholder(stmtPlaceholder, "Statement");
    }
    parseBlock(allowDirectives, createNewLexicalScope, afterBlockParse) {
      return this.parsePlaceholder("BlockStatement") || super.parseBlock(allowDirectives, createNewLexicalScope, afterBlockParse);
    }
    parseFunctionId(requireId) {
      return this.parsePlaceholder("Identifier") || super.parseFunctionId(requireId);
    }
    parseClass(node, isStatement, optionalId) {
      const type = isStatement ? "ClassDeclaration" : "ClassExpression";
      this.next();
      const oldStrict = this.state.strict;
      const placeholder = this.parsePlaceholder("Identifier");
      if (placeholder) {
        if (this.match(81) || this.match(133) || this.match(5)) {
          node.id = placeholder;
        } else if (optionalId || !isStatement) {
          node.id = null;
          node.body = this.finishPlaceholder(placeholder, "ClassBody");
          return this.finishNode(node, type);
        } else {
          throw this.raise(PlaceholderErrors.ClassNameIsRequired, this.state.startLoc);
        }
      } else {
        this.parseClassId(node, isStatement, optionalId);
      }
      super.parseClassSuper(node);
      node.body = this.parsePlaceholder("ClassBody") || super.parseClassBody(!!node.superClass, oldStrict);
      return this.finishNode(node, type);
    }
    parseExport(node, decorators) {
      const placeholder = this.parsePlaceholder("Identifier");
      if (!placeholder)
        return super.parseExport(node, decorators);
      const node2 = node;
      if (!this.isContextual(98) && !this.match(12)) {
        node2.specifiers = [];
        node2.source = null;
        node2.declaration = this.finishPlaceholder(placeholder, "Declaration");
        return this.finishNode(node2, "ExportNamedDeclaration");
      }
      this.expectPlugin("exportDefaultFrom");
      const specifier = this.startNode();
      specifier.exported = placeholder;
      node2.specifiers = [this.finishNode(specifier, "ExportDefaultSpecifier")];
      return super.parseExport(node2, decorators);
    }
    isExportDefaultSpecifier() {
      if (this.match(65)) {
        const next = this.nextTokenStart();
        if (this.isUnparsedContextual(next, "from")) {
          if (this.input.startsWith(tokenLabelName(133), this.nextTokenStartSince(next + 4))) {
            return true;
          }
        }
      }
      return super.isExportDefaultSpecifier();
    }
    maybeParseExportDefaultSpecifier(node, maybeDefaultIdentifier) {
      var _specifiers;
      if ((_specifiers = node.specifiers) != null && _specifiers.length) {
        return true;
      }
      return super.maybeParseExportDefaultSpecifier(node, maybeDefaultIdentifier);
    }
    checkExport(node) {
      const {
        specifiers
      } = node;
      if (specifiers != null && specifiers.length) {
        node.specifiers = specifiers.filter((node2) => node2.exported.type === "Placeholder");
      }
      super.checkExport(node);
      node.specifiers = specifiers;
    }
    parseImport(node) {
      const placeholder = this.parsePlaceholder("Identifier");
      if (!placeholder)
        return super.parseImport(node);
      node.specifiers = [];
      if (!this.isContextual(98) && !this.match(12)) {
        node.source = this.finishPlaceholder(placeholder, "StringLiteral");
        this.semicolon();
        return this.finishNode(node, "ImportDeclaration");
      }
      const specifier = this.startNodeAtNode(placeholder);
      specifier.local = placeholder;
      node.specifiers.push(this.finishNode(specifier, "ImportDefaultSpecifier"));
      if (this.eat(12)) {
        const hasStarImport = this.maybeParseStarImportSpecifier(node);
        if (!hasStarImport)
          this.parseNamedImportSpecifiers(node);
      }
      this.expectContextual(98);
      node.source = this.parseImportSource();
      this.semicolon();
      return this.finishNode(node, "ImportDeclaration");
    }
    parseImportSource() {
      return this.parsePlaceholder("StringLiteral") || super.parseImportSource();
    }
    assertNoSpace() {
      if (this.state.start > this.offsetToSourcePos(this.state.lastTokEndLoc.index)) {
        this.raise(PlaceholderErrors.UnexpectedSpace, this.state.lastTokEndLoc);
      }
    }
  };
  var v8intrinsic = (superClass) => class V8IntrinsicMixin extends superClass {
    parseV8Intrinsic() {
      if (this.match(54)) {
        const v8IntrinsicStartLoc = this.state.startLoc;
        const node = this.startNode();
        this.next();
        if (tokenIsIdentifier(this.state.type)) {
          const name = this.parseIdentifierName();
          const identifier = this.createIdentifier(node, name);
          this.castNodeTo(identifier, "V8IntrinsicIdentifier");
          if (this.match(10)) {
            return identifier;
          }
        }
        this.unexpected(v8IntrinsicStartLoc);
      }
    }
    parseExprAtom(refExpressionErrors) {
      return this.parseV8Intrinsic() || super.parseExprAtom(refExpressionErrors);
    }
  };
  var PIPELINE_PROPOSALS = ["minimal", "fsharp", "hack", "smart"];
  var TOPIC_TOKENS = ["^^", "@@", "^", "%", "#"];
  function validatePlugins(pluginsMap) {
    if (pluginsMap.has("decorators")) {
      if (pluginsMap.has("decorators-legacy")) {
        throw new Error("Cannot use the decorators and decorators-legacy plugin together");
      }
      const decoratorsBeforeExport = pluginsMap.get("decorators").decoratorsBeforeExport;
      if (decoratorsBeforeExport != null && typeof decoratorsBeforeExport !== "boolean") {
        throw new Error("'decoratorsBeforeExport' must be a boolean, if specified.");
      }
      const allowCallParenthesized = pluginsMap.get("decorators").allowCallParenthesized;
      if (allowCallParenthesized != null && typeof allowCallParenthesized !== "boolean") {
        throw new Error("'allowCallParenthesized' must be a boolean.");
      }
    }
    if (pluginsMap.has("flow") && pluginsMap.has("typescript")) {
      throw new Error("Cannot combine flow and typescript plugins.");
    }
    if (pluginsMap.has("placeholders") && pluginsMap.has("v8intrinsic")) {
      throw new Error("Cannot combine placeholders and v8intrinsic plugins.");
    }
    if (pluginsMap.has("pipelineOperator")) {
      var _pluginsMap$get2;
      const proposal = pluginsMap.get("pipelineOperator").proposal;
      if (!PIPELINE_PROPOSALS.includes(proposal)) {
        const proposalList = PIPELINE_PROPOSALS.map((p) => `"${p}"`).join(", ");
        throw new Error(`"pipelineOperator" requires "proposal" option whose value must be one of: ${proposalList}.`);
      }
      if (proposal === "hack") {
        var _pluginsMap$get;
        if (pluginsMap.has("placeholders")) {
          throw new Error("Cannot combine placeholders plugin and Hack-style pipes.");
        }
        if (pluginsMap.has("v8intrinsic")) {
          throw new Error("Cannot combine v8intrinsic plugin and Hack-style pipes.");
        }
        const topicToken = pluginsMap.get("pipelineOperator").topicToken;
        if (!TOPIC_TOKENS.includes(topicToken)) {
          const tokenList = TOPIC_TOKENS.map((t) => `"${t}"`).join(", ");
          throw new Error(`"pipelineOperator" in "proposal": "hack" mode also requires a "topicToken" option whose value must be one of: ${tokenList}.`);
        }
        if (topicToken === "#" && ((_pluginsMap$get = pluginsMap.get("recordAndTuple")) == null ? undefined : _pluginsMap$get.syntaxType) === "hash") {
          throw new Error(`Plugin conflict between \`["pipelineOperator", { proposal: "hack", topicToken: "#" }]\` and \`${JSON.stringify(["recordAndTuple", pluginsMap.get("recordAndTuple")])}\`.`);
        }
      } else if (proposal === "smart" && ((_pluginsMap$get2 = pluginsMap.get("recordAndTuple")) == null ? undefined : _pluginsMap$get2.syntaxType) === "hash") {
        throw new Error(`Plugin conflict between \`["pipelineOperator", { proposal: "smart" }]\` and \`${JSON.stringify(["recordAndTuple", pluginsMap.get("recordAndTuple")])}\`.`);
      }
    }
    if (pluginsMap.has("moduleAttributes")) {
      if (pluginsMap.has("deprecatedImportAssert") || pluginsMap.has("importAssertions")) {
        throw new Error("Cannot combine importAssertions, deprecatedImportAssert and moduleAttributes plugins.");
      }
      const moduleAttributesVersionPluginOption = pluginsMap.get("moduleAttributes").version;
      if (moduleAttributesVersionPluginOption !== "may-2020") {
        throw new Error("The 'moduleAttributes' plugin requires a 'version' option," + " representing the last proposal update. Currently, the" + " only supported value is 'may-2020'.");
      }
    }
    if (pluginsMap.has("importAssertions")) {
      if (pluginsMap.has("deprecatedImportAssert")) {
        throw new Error("Cannot combine importAssertions and deprecatedImportAssert plugins.");
      }
    }
    if (pluginsMap.has("deprecatedImportAssert"))
      ;
    else if (pluginsMap.has("importAttributes") && pluginsMap.get("importAttributes").deprecatedAssertSyntax) {
      pluginsMap.set("deprecatedImportAssert", {});
    }
    if (pluginsMap.has("recordAndTuple")) {
      const syntaxType = pluginsMap.get("recordAndTuple").syntaxType;
      if (syntaxType != null) {
        const RECORD_AND_TUPLE_SYNTAX_TYPES = ["hash", "bar"];
        if (!RECORD_AND_TUPLE_SYNTAX_TYPES.includes(syntaxType)) {
          throw new Error("The 'syntaxType' option of the 'recordAndTuple' plugin must be one of: " + RECORD_AND_TUPLE_SYNTAX_TYPES.map((p) => `'${p}'`).join(", "));
        }
      }
    }
    if (pluginsMap.has("asyncDoExpressions") && !pluginsMap.has("doExpressions")) {
      const error2 = new Error("'asyncDoExpressions' requires 'doExpressions', please add 'doExpressions' to parser plugins.");
      error2.missingPlugins = "doExpressions";
      throw error2;
    }
    if (pluginsMap.has("optionalChainingAssign") && pluginsMap.get("optionalChainingAssign").version !== "2023-07") {
      throw new Error("The 'optionalChainingAssign' plugin requires a 'version' option," + " representing the last proposal update. Currently, the" + " only supported value is '2023-07'.");
    }
    if (pluginsMap.has("discardBinding") && pluginsMap.get("discardBinding").syntaxType !== "void") {
      throw new Error("The 'discardBinding' plugin requires a 'syntaxType' option. Currently the only supported value is 'void'.");
    }
  }
  var mixinPlugins = {
    estree,
    jsx,
    flow,
    typescript,
    v8intrinsic,
    placeholders
  };
  var mixinPluginNames = Object.keys(mixinPlugins);

  class ExpressionParser extends LValParser {
    checkProto(prop, isRecord, sawProto, refExpressionErrors) {
      if (prop.type === "SpreadElement" || this.isObjectMethod(prop) || prop.computed || prop.shorthand) {
        return sawProto;
      }
      const key = prop.key;
      const name = key.type === "Identifier" ? key.name : key.value;
      if (name === "__proto__") {
        if (isRecord) {
          this.raise(Errors.RecordNoProto, key);
          return true;
        }
        if (sawProto) {
          if (refExpressionErrors) {
            if (refExpressionErrors.doubleProtoLoc === null) {
              refExpressionErrors.doubleProtoLoc = key.loc.start;
            }
          } else {
            this.raise(Errors.DuplicateProto, key);
          }
        }
        return true;
      }
      return sawProto;
    }
    shouldExitDescending(expr, potentialArrowAt) {
      return expr.type === "ArrowFunctionExpression" && this.offsetToSourcePos(expr.start) === potentialArrowAt;
    }
    getExpression() {
      this.enterInitialScopes();
      this.nextToken();
      if (this.match(140)) {
        throw this.raise(Errors.ParseExpressionEmptyInput, this.state.startLoc);
      }
      const expr = this.parseExpression();
      if (!this.match(140)) {
        throw this.raise(Errors.ParseExpressionExpectsEOF, this.state.startLoc, {
          unexpected: this.input.codePointAt(this.state.start)
        });
      }
      this.finalizeRemainingComments();
      expr.comments = this.comments;
      expr.errors = this.state.errors;
      if (this.optionFlags & 256) {
        expr.tokens = this.tokens;
      }
      return expr;
    }
    parseExpression(disallowIn, refExpressionErrors) {
      if (disallowIn) {
        return this.disallowInAnd(() => this.parseExpressionBase(refExpressionErrors));
      }
      return this.allowInAnd(() => this.parseExpressionBase(refExpressionErrors));
    }
    parseExpressionBase(refExpressionErrors) {
      const startLoc = this.state.startLoc;
      const expr = this.parseMaybeAssign(refExpressionErrors);
      if (this.match(12)) {
        const node = this.startNodeAt(startLoc);
        node.expressions = [expr];
        while (this.eat(12)) {
          node.expressions.push(this.parseMaybeAssign(refExpressionErrors));
        }
        this.toReferencedList(node.expressions);
        return this.finishNode(node, "SequenceExpression");
      }
      return expr;
    }
    parseMaybeAssignDisallowIn(refExpressionErrors, afterLeftParse) {
      return this.disallowInAnd(() => this.parseMaybeAssign(refExpressionErrors, afterLeftParse));
    }
    parseMaybeAssignAllowIn(refExpressionErrors, afterLeftParse) {
      return this.allowInAnd(() => this.parseMaybeAssign(refExpressionErrors, afterLeftParse));
    }
    setOptionalParametersError(refExpressionErrors) {
      refExpressionErrors.optionalParametersLoc = this.state.startLoc;
    }
    parseMaybeAssign(refExpressionErrors, afterLeftParse) {
      const startLoc = this.state.startLoc;
      const isYield = this.isContextual(108);
      if (isYield) {
        if (this.prodParam.hasYield) {
          this.next();
          let left2 = this.parseYield(startLoc);
          if (afterLeftParse) {
            left2 = afterLeftParse.call(this, left2, startLoc);
          }
          return left2;
        }
      }
      let ownExpressionErrors;
      if (refExpressionErrors) {
        ownExpressionErrors = false;
      } else {
        refExpressionErrors = new ExpressionErrors;
        ownExpressionErrors = true;
      }
      const {
        type
      } = this.state;
      if (type === 10 || tokenIsIdentifier(type)) {
        this.state.potentialArrowAt = this.state.start;
      }
      let left = this.parseMaybeConditional(refExpressionErrors);
      if (afterLeftParse) {
        left = afterLeftParse.call(this, left, startLoc);
      }
      if (tokenIsAssignment(this.state.type)) {
        const node = this.startNodeAt(startLoc);
        const operator = this.state.value;
        node.operator = operator;
        if (this.match(29)) {
          this.toAssignable(left, true);
          node.left = left;
          const startIndex = startLoc.index;
          if (refExpressionErrors.doubleProtoLoc != null && refExpressionErrors.doubleProtoLoc.index >= startIndex) {
            refExpressionErrors.doubleProtoLoc = null;
          }
          if (refExpressionErrors.shorthandAssignLoc != null && refExpressionErrors.shorthandAssignLoc.index >= startIndex) {
            refExpressionErrors.shorthandAssignLoc = null;
          }
          if (refExpressionErrors.privateKeyLoc != null && refExpressionErrors.privateKeyLoc.index >= startIndex) {
            this.checkDestructuringPrivate(refExpressionErrors);
            refExpressionErrors.privateKeyLoc = null;
          }
          if (refExpressionErrors.voidPatternLoc != null && refExpressionErrors.voidPatternLoc.index >= startIndex) {
            refExpressionErrors.voidPatternLoc = null;
          }
        } else {
          node.left = left;
        }
        this.next();
        node.right = this.parseMaybeAssign();
        this.checkLVal(left, this.finishNode(node, "AssignmentExpression"), undefined, undefined, undefined, undefined, operator === "||=" || operator === "&&=" || operator === "??=");
        return node;
      } else if (ownExpressionErrors) {
        this.checkExpressionErrors(refExpressionErrors, true);
      }
      if (isYield) {
        const {
          type: type2
        } = this.state;
        const startsExpr2 = this.hasPlugin("v8intrinsic") ? tokenCanStartExpression(type2) : tokenCanStartExpression(type2) && !this.match(54);
        if (startsExpr2 && !this.isAmbiguousPrefixOrIdentifier()) {
          this.raiseOverwrite(Errors.YieldNotInGeneratorFunction, startLoc);
          return this.parseYield(startLoc);
        }
      }
      return left;
    }
    parseMaybeConditional(refExpressionErrors) {
      const startLoc = this.state.startLoc;
      const potentialArrowAt = this.state.potentialArrowAt;
      const expr = this.parseExprOps(refExpressionErrors);
      if (this.shouldExitDescending(expr, potentialArrowAt)) {
        return expr;
      }
      return this.parseConditional(expr, startLoc, refExpressionErrors);
    }
    parseConditional(expr, startLoc, refExpressionErrors) {
      if (this.eat(17)) {
        const node = this.startNodeAt(startLoc);
        node.test = expr;
        node.consequent = this.parseMaybeAssignAllowIn();
        this.expect(14);
        node.alternate = this.parseMaybeAssign();
        return this.finishNode(node, "ConditionalExpression");
      }
      return expr;
    }
    parseMaybeUnaryOrPrivate(refExpressionErrors) {
      return this.match(139) ? this.parsePrivateName() : this.parseMaybeUnary(refExpressionErrors);
    }
    parseExprOps(refExpressionErrors) {
      const startLoc = this.state.startLoc;
      const potentialArrowAt = this.state.potentialArrowAt;
      const expr = this.parseMaybeUnaryOrPrivate(refExpressionErrors);
      if (this.shouldExitDescending(expr, potentialArrowAt)) {
        return expr;
      }
      return this.parseExprOp(expr, startLoc, -1);
    }
    parseExprOp(left, leftStartLoc, minPrec) {
      if (this.isPrivateName(left)) {
        const value = this.getPrivateNameSV(left);
        if (minPrec >= tokenOperatorPrecedence(58) || !this.prodParam.hasIn || !this.match(58)) {
          this.raise(Errors.PrivateInExpectedIn, left, {
            identifierName: value
          });
        }
        this.classScope.usePrivateName(value, left.loc.start);
      }
      const op = this.state.type;
      if (tokenIsOperator(op) && (this.prodParam.hasIn || !this.match(58))) {
        let prec = tokenOperatorPrecedence(op);
        if (prec > minPrec) {
          if (op === 39) {
            this.expectPlugin("pipelineOperator");
            if (this.state.inFSharpPipelineDirectBody) {
              return left;
            }
            this.checkPipelineAtInfixOperator(left, leftStartLoc);
          }
          const node = this.startNodeAt(leftStartLoc);
          node.left = left;
          node.operator = this.state.value;
          const logical = op === 41 || op === 42;
          const coalesce = op === 40;
          if (coalesce) {
            prec = tokenOperatorPrecedence(42);
          }
          this.next();
          if (op === 39 && this.hasPlugin(["pipelineOperator", {
            proposal: "minimal"
          }])) {
            if (this.state.type === 96 && this.prodParam.hasAwait) {
              throw this.raise(Errors.UnexpectedAwaitAfterPipelineBody, this.state.startLoc);
            }
          }
          node.right = this.parseExprOpRightExpr(op, prec);
          const finishedNode = this.finishNode(node, logical || coalesce ? "LogicalExpression" : "BinaryExpression");
          const nextOp = this.state.type;
          if (coalesce && (nextOp === 41 || nextOp === 42) || logical && nextOp === 40) {
            throw this.raise(Errors.MixingCoalesceWithLogical, this.state.startLoc);
          }
          return this.parseExprOp(finishedNode, leftStartLoc, minPrec);
        }
      }
      return left;
    }
    parseExprOpRightExpr(op, prec) {
      const startLoc = this.state.startLoc;
      switch (op) {
        case 39:
          switch (this.getPluginOption("pipelineOperator", "proposal")) {
            case "hack":
              return this.withTopicBindingContext(() => {
                return this.parseHackPipeBody();
              });
            case "fsharp":
              return this.withSoloAwaitPermittingContext(() => {
                return this.parseFSharpPipelineBody(prec);
              });
          }
          if (this.getPluginOption("pipelineOperator", "proposal") === "smart") {
            return this.withTopicBindingContext(() => {
              if (this.prodParam.hasYield && this.isContextual(108)) {
                throw this.raise(Errors.PipeBodyIsTighter, this.state.startLoc);
              }
              return this.parseSmartPipelineBodyInStyle(this.parseExprOpBaseRightExpr(op, prec), startLoc);
            });
          }
        default:
          return this.parseExprOpBaseRightExpr(op, prec);
      }
    }
    parseExprOpBaseRightExpr(op, prec) {
      const startLoc = this.state.startLoc;
      return this.parseExprOp(this.parseMaybeUnaryOrPrivate(), startLoc, tokenIsRightAssociative(op) ? prec - 1 : prec);
    }
    parseHackPipeBody() {
      var _body$extra;
      const {
        startLoc
      } = this.state;
      const body = this.parseMaybeAssign();
      const requiredParentheses = UnparenthesizedPipeBodyDescriptions.has(body.type);
      if (requiredParentheses && !((_body$extra = body.extra) != null && _body$extra.parenthesized)) {
        this.raise(Errors.PipeUnparenthesizedBody, startLoc, {
          type: body.type
        });
      }
      if (!this.topicReferenceWasUsedInCurrentContext()) {
        this.raise(Errors.PipeTopicUnused, startLoc);
      }
      return body;
    }
    checkExponentialAfterUnary(node) {
      if (this.match(57)) {
        this.raise(Errors.UnexpectedTokenUnaryExponentiation, node.argument);
      }
    }
    parseMaybeUnary(refExpressionErrors, sawUnary) {
      const startLoc = this.state.startLoc;
      const isAwait = this.isContextual(96);
      if (isAwait && this.recordAwaitIfAllowed()) {
        this.next();
        const expr2 = this.parseAwait(startLoc);
        if (!sawUnary)
          this.checkExponentialAfterUnary(expr2);
        return expr2;
      }
      const update = this.match(34);
      const node = this.startNode();
      if (tokenIsPrefix(this.state.type)) {
        node.operator = this.state.value;
        node.prefix = true;
        if (this.match(72)) {
          this.expectPlugin("throwExpressions");
        }
        const isDelete = this.match(89);
        this.next();
        node.argument = this.parseMaybeUnary(null, true);
        this.checkExpressionErrors(refExpressionErrors, true);
        if (this.state.strict && isDelete) {
          const arg = node.argument;
          if (arg.type === "Identifier") {
            this.raise(Errors.StrictDelete, node);
          } else if (this.hasPropertyAsPrivateName(arg)) {
            this.raise(Errors.DeletePrivateField, node);
          }
        }
        if (!update) {
          if (!sawUnary) {
            this.checkExponentialAfterUnary(node);
          }
          return this.finishNode(node, "UnaryExpression");
        }
      }
      const expr = this.parseUpdate(node, update, refExpressionErrors);
      if (isAwait) {
        const {
          type
        } = this.state;
        const startsExpr2 = this.hasPlugin("v8intrinsic") ? tokenCanStartExpression(type) : tokenCanStartExpression(type) && !this.match(54);
        if (startsExpr2 && !this.isAmbiguousPrefixOrIdentifier()) {
          this.raiseOverwrite(Errors.AwaitNotInAsyncContext, startLoc);
          return this.parseAwait(startLoc);
        }
      }
      return expr;
    }
    parseUpdate(node, update, refExpressionErrors) {
      if (update) {
        const updateExpressionNode = node;
        this.checkLVal(updateExpressionNode.argument, this.finishNode(updateExpressionNode, "UpdateExpression"));
        return node;
      }
      const startLoc = this.state.startLoc;
      let expr = this.parseExprSubscripts(refExpressionErrors);
      if (this.checkExpressionErrors(refExpressionErrors, false))
        return expr;
      while (tokenIsPostfix(this.state.type) && !this.canInsertSemicolon()) {
        const node2 = this.startNodeAt(startLoc);
        node2.operator = this.state.value;
        node2.prefix = false;
        node2.argument = expr;
        this.next();
        this.checkLVal(expr, expr = this.finishNode(node2, "UpdateExpression"));
      }
      return expr;
    }
    parseExprSubscripts(refExpressionErrors) {
      const startLoc = this.state.startLoc;
      const potentialArrowAt = this.state.potentialArrowAt;
      const expr = this.parseExprAtom(refExpressionErrors);
      if (this.shouldExitDescending(expr, potentialArrowAt)) {
        return expr;
      }
      return this.parseSubscripts(expr, startLoc);
    }
    parseSubscripts(base, startLoc, noCalls) {
      const state = {
        optionalChainMember: false,
        maybeAsyncArrow: this.atPossibleAsyncArrow(base),
        stop: false
      };
      do {
        base = this.parseSubscript(base, startLoc, noCalls, state);
        state.maybeAsyncArrow = false;
      } while (!state.stop);
      return base;
    }
    parseSubscript(base, startLoc, noCalls, state) {
      const {
        type
      } = this.state;
      if (!noCalls && type === 15) {
        return this.parseBind(base, startLoc, noCalls, state);
      } else if (tokenIsTemplate(type)) {
        return this.parseTaggedTemplateExpression(base, startLoc, state);
      }
      let optional = false;
      if (type === 18) {
        if (noCalls) {
          this.raise(Errors.OptionalChainingNoNew, this.state.startLoc);
          if (this.lookaheadCharCode() === 40) {
            return this.stopParseSubscript(base, state);
          }
        }
        state.optionalChainMember = optional = true;
        this.next();
      }
      if (!noCalls && this.match(10)) {
        return this.parseCoverCallAndAsyncArrowHead(base, startLoc, state, optional);
      } else {
        const computed = this.eat(0);
        if (computed || optional || this.eat(16)) {
          return this.parseMember(base, startLoc, state, computed, optional);
        } else {
          return this.stopParseSubscript(base, state);
        }
      }
    }
    stopParseSubscript(base, state) {
      state.stop = true;
      return base;
    }
    parseMember(base, startLoc, state, computed, optional) {
      const node = this.startNodeAt(startLoc);
      node.object = base;
      node.computed = computed;
      if (computed) {
        node.property = this.parseExpression();
        this.expect(3);
      } else if (this.match(139)) {
        if (base.type === "Super") {
          this.raise(Errors.SuperPrivateField, startLoc);
        }
        this.classScope.usePrivateName(this.state.value, this.state.startLoc);
        node.property = this.parsePrivateName();
      } else {
        node.property = this.parseIdentifier(true);
      }
      if (state.optionalChainMember) {
        node.optional = optional;
        return this.finishNode(node, "OptionalMemberExpression");
      } else {
        return this.finishNode(node, "MemberExpression");
      }
    }
    parseBind(base, startLoc, noCalls, state) {
      const node = this.startNodeAt(startLoc);
      node.object = base;
      this.next();
      node.callee = this.parseNoCallExpr();
      state.stop = true;
      return this.parseSubscripts(this.finishNode(node, "BindExpression"), startLoc, noCalls);
    }
    parseCoverCallAndAsyncArrowHead(base, startLoc, state, optional) {
      const oldMaybeInArrowParameters = this.state.maybeInArrowParameters;
      let refExpressionErrors = null;
      this.state.maybeInArrowParameters = true;
      this.next();
      const node = this.startNodeAt(startLoc);
      node.callee = base;
      const {
        maybeAsyncArrow,
        optionalChainMember
      } = state;
      if (maybeAsyncArrow) {
        this.expressionScope.enter(newAsyncArrowScope());
        refExpressionErrors = new ExpressionErrors;
      }
      if (optionalChainMember) {
        node.optional = optional;
      }
      if (optional) {
        node.arguments = this.parseCallExpressionArguments();
      } else {
        node.arguments = this.parseCallExpressionArguments(base.type !== "Super", node, refExpressionErrors);
      }
      let finishedNode = this.finishCallExpression(node, optionalChainMember);
      if (maybeAsyncArrow && this.shouldParseAsyncArrow() && !optional) {
        state.stop = true;
        this.checkDestructuringPrivate(refExpressionErrors);
        this.expressionScope.validateAsPattern();
        this.expressionScope.exit();
        finishedNode = this.parseAsyncArrowFromCallExpression(this.startNodeAt(startLoc), finishedNode);
      } else {
        if (maybeAsyncArrow) {
          this.checkExpressionErrors(refExpressionErrors, true);
          this.expressionScope.exit();
        }
        this.toReferencedArguments(finishedNode);
      }
      this.state.maybeInArrowParameters = oldMaybeInArrowParameters;
      return finishedNode;
    }
    toReferencedArguments(node, isParenthesizedExpr) {
      this.toReferencedListDeep(node.arguments, isParenthesizedExpr);
    }
    parseTaggedTemplateExpression(base, startLoc, state) {
      const node = this.startNodeAt(startLoc);
      node.tag = base;
      node.quasi = this.parseTemplate(true);
      if (state.optionalChainMember) {
        this.raise(Errors.OptionalChainingNoTemplate, startLoc);
      }
      return this.finishNode(node, "TaggedTemplateExpression");
    }
    atPossibleAsyncArrow(base) {
      return base.type === "Identifier" && base.name === "async" && this.state.lastTokEndLoc.index === base.end && !this.canInsertSemicolon() && base.end - base.start === 5 && this.offsetToSourcePos(base.start) === this.state.potentialArrowAt;
    }
    finishCallExpression(node, optional) {
      if (node.callee.type === "Import") {
        if (node.arguments.length === 0 || node.arguments.length > 2) {
          this.raise(Errors.ImportCallArity, node);
        } else {
          for (const arg of node.arguments) {
            if (arg.type === "SpreadElement") {
              this.raise(Errors.ImportCallSpreadArgument, arg);
            }
          }
        }
      }
      return this.finishNode(node, optional ? "OptionalCallExpression" : "CallExpression");
    }
    parseCallExpressionArguments(allowPlaceholder, nodeForExtra, refExpressionErrors) {
      const elts = [];
      let first = true;
      const oldInFSharpPipelineDirectBody = this.state.inFSharpPipelineDirectBody;
      this.state.inFSharpPipelineDirectBody = false;
      while (!this.eat(11)) {
        if (first) {
          first = false;
        } else {
          this.expect(12);
          if (this.match(11)) {
            if (nodeForExtra) {
              this.addTrailingCommaExtraToNode(nodeForExtra);
            }
            this.next();
            break;
          }
        }
        elts.push(this.parseExprListItem(11, false, refExpressionErrors, allowPlaceholder));
      }
      this.state.inFSharpPipelineDirectBody = oldInFSharpPipelineDirectBody;
      return elts;
    }
    shouldParseAsyncArrow() {
      return this.match(19) && !this.canInsertSemicolon();
    }
    parseAsyncArrowFromCallExpression(node, call) {
      var _call$extra;
      this.resetPreviousNodeTrailingComments(call);
      this.expect(19);
      this.parseArrowExpression(node, call.arguments, true, (_call$extra = call.extra) == null ? undefined : _call$extra.trailingCommaLoc);
      if (call.innerComments) {
        setInnerComments(node, call.innerComments);
      }
      if (call.callee.trailingComments) {
        setInnerComments(node, call.callee.trailingComments);
      }
      return node;
    }
    parseNoCallExpr() {
      const startLoc = this.state.startLoc;
      return this.parseSubscripts(this.parseExprAtom(), startLoc, true);
    }
    parseExprAtom(refExpressionErrors) {
      let node;
      let decorators = null;
      const {
        type
      } = this.state;
      switch (type) {
        case 79:
          return this.parseSuper();
        case 83:
          node = this.startNode();
          this.next();
          if (this.match(16)) {
            return this.parseImportMetaPropertyOrPhaseCall(node);
          }
          if (this.match(10)) {
            if (this.optionFlags & 512) {
              return this.parseImportCall(node);
            } else {
              return this.finishNode(node, "Import");
            }
          } else {
            this.raise(Errors.UnsupportedImport, this.state.lastTokStartLoc);
            return this.finishNode(node, "Import");
          }
        case 78:
          node = this.startNode();
          this.next();
          return this.finishNode(node, "ThisExpression");
        case 90: {
          return this.parseDo(this.startNode(), false);
        }
        case 56:
        case 31: {
          this.readRegexp();
          return this.parseRegExpLiteral(this.state.value);
        }
        case 135:
          return this.parseNumericLiteral(this.state.value);
        case 136:
          return this.parseBigIntLiteral(this.state.value);
        case 134:
          return this.parseStringLiteral(this.state.value);
        case 84:
          return this.parseNullLiteral();
        case 85:
          return this.parseBooleanLiteral(true);
        case 86:
          return this.parseBooleanLiteral(false);
        case 10: {
          const canBeArrow = this.state.potentialArrowAt === this.state.start;
          return this.parseParenAndDistinguishExpression(canBeArrow);
        }
        case 0: {
          return this.parseArrayLike(3, false, refExpressionErrors);
        }
        case 5: {
          return this.parseObjectLike(8, false, false, refExpressionErrors);
        }
        case 68:
          return this.parseFunctionOrFunctionSent();
        case 26:
          decorators = this.parseDecorators();
        case 80:
          return this.parseClass(this.maybeTakeDecorators(decorators, this.startNode()), false);
        case 77:
          return this.parseNewOrNewTarget();
        case 25:
        case 24:
          return this.parseTemplate(false);
        case 15: {
          node = this.startNode();
          this.next();
          node.object = null;
          const callee = node.callee = this.parseNoCallExpr();
          if (callee.type === "MemberExpression") {
            return this.finishNode(node, "BindExpression");
          } else {
            throw this.raise(Errors.UnsupportedBind, callee);
          }
        }
        case 139: {
          this.raise(Errors.PrivateInExpectedIn, this.state.startLoc, {
            identifierName: this.state.value
          });
          return this.parsePrivateName();
        }
        case 33: {
          return this.parseTopicReferenceThenEqualsSign(54, "%");
        }
        case 32: {
          return this.parseTopicReferenceThenEqualsSign(44, "^");
        }
        case 37:
        case 38: {
          return this.parseTopicReference("hack");
        }
        case 44:
        case 54:
        case 27: {
          const pipeProposal = this.getPluginOption("pipelineOperator", "proposal");
          if (pipeProposal) {
            return this.parseTopicReference(pipeProposal);
          }
          throw this.unexpected();
        }
        case 47: {
          const lookaheadCh = this.input.codePointAt(this.nextTokenStart());
          if (isIdentifierStart(lookaheadCh) || lookaheadCh === 62) {
            throw this.expectOnePlugin(["jsx", "flow", "typescript"]);
          }
          throw this.unexpected();
        }
        default:
          if (type === 137) {
            return this.parseDecimalLiteral(this.state.value);
          } else if (type === 2 || type === 1) {
            return this.parseArrayLike(this.state.type === 2 ? 4 : 3, true);
          } else if (type === 6 || type === 7) {
            return this.parseObjectLike(this.state.type === 6 ? 9 : 8, false, true);
          }
          if (tokenIsIdentifier(type)) {
            if (this.isContextual(127) && this.lookaheadInLineCharCode() === 123) {
              return this.parseModuleExpression();
            }
            const canBeArrow = this.state.potentialArrowAt === this.state.start;
            const containsEsc = this.state.containsEsc;
            const id = this.parseIdentifier();
            if (!containsEsc && id.name === "async" && !this.canInsertSemicolon()) {
              const {
                type: type2
              } = this.state;
              if (type2 === 68) {
                this.resetPreviousNodeTrailingComments(id);
                this.next();
                return this.parseAsyncFunctionExpression(this.startNodeAtNode(id));
              } else if (tokenIsIdentifier(type2)) {
                if (canBeArrow && this.lookaheadCharCode() === 61) {
                  return this.parseAsyncArrowUnaryFunction(this.startNodeAtNode(id));
                } else {
                  return id;
                }
              } else if (type2 === 90) {
                this.resetPreviousNodeTrailingComments(id);
                return this.parseDo(this.startNodeAtNode(id), true);
              }
            }
            if (canBeArrow && this.match(19) && !this.canInsertSemicolon()) {
              this.next();
              return this.parseArrowExpression(this.startNodeAtNode(id), [id], false);
            }
            return id;
          } else {
            throw this.unexpected();
          }
      }
    }
    parseTopicReferenceThenEqualsSign(topicTokenType, topicTokenValue) {
      const pipeProposal = this.getPluginOption("pipelineOperator", "proposal");
      if (pipeProposal) {
        this.state.type = topicTokenType;
        this.state.value = topicTokenValue;
        this.state.pos--;
        this.state.end--;
        this.state.endLoc = createPositionWithColumnOffset(this.state.endLoc, -1);
        return this.parseTopicReference(pipeProposal);
      }
      throw this.unexpected();
    }
    parseTopicReference(pipeProposal) {
      const node = this.startNode();
      const startLoc = this.state.startLoc;
      const tokenType = this.state.type;
      this.next();
      return this.finishTopicReference(node, startLoc, pipeProposal, tokenType);
    }
    finishTopicReference(node, startLoc, pipeProposal, tokenType) {
      if (this.testTopicReferenceConfiguration(pipeProposal, startLoc, tokenType)) {
        if (pipeProposal === "hack") {
          if (!this.topicReferenceIsAllowedInCurrentContext()) {
            this.raise(Errors.PipeTopicUnbound, startLoc);
          }
          this.registerTopicReference();
          return this.finishNode(node, "TopicReference");
        } else {
          if (!this.topicReferenceIsAllowedInCurrentContext()) {
            this.raise(Errors.PrimaryTopicNotAllowed, startLoc);
          }
          this.registerTopicReference();
          return this.finishNode(node, "PipelinePrimaryTopicReference");
        }
      } else {
        throw this.raise(Errors.PipeTopicUnconfiguredToken, startLoc, {
          token: tokenLabelName(tokenType)
        });
      }
    }
    testTopicReferenceConfiguration(pipeProposal, startLoc, tokenType) {
      switch (pipeProposal) {
        case "hack": {
          return this.hasPlugin(["pipelineOperator", {
            topicToken: tokenLabelName(tokenType)
          }]);
        }
        case "smart":
          return tokenType === 27;
        default:
          throw this.raise(Errors.PipeTopicRequiresHackPipes, startLoc);
      }
    }
    parseAsyncArrowUnaryFunction(node) {
      this.prodParam.enter(functionFlags(true, this.prodParam.hasYield));
      const params = [this.parseIdentifier()];
      this.prodParam.exit();
      if (this.hasPrecedingLineBreak()) {
        this.raise(Errors.LineTerminatorBeforeArrow, this.state.curPosition());
      }
      this.expect(19);
      return this.parseArrowExpression(node, params, true);
    }
    parseDo(node, isAsync) {
      this.expectPlugin("doExpressions");
      if (isAsync) {
        this.expectPlugin("asyncDoExpressions");
      }
      node.async = isAsync;
      this.next();
      const oldLabels = this.state.labels;
      this.state.labels = [];
      if (isAsync) {
        this.prodParam.enter(2);
        node.body = this.parseBlock();
        this.prodParam.exit();
      } else {
        node.body = this.parseBlock();
      }
      this.state.labels = oldLabels;
      return this.finishNode(node, "DoExpression");
    }
    parseSuper() {
      const node = this.startNode();
      this.next();
      if (this.match(10) && !this.scope.allowDirectSuper) {
        if (!(this.optionFlags & 16)) {
          this.raise(Errors.SuperNotAllowed, node);
        }
      } else if (!this.scope.allowSuper) {
        if (!(this.optionFlags & 16)) {
          this.raise(Errors.UnexpectedSuper, node);
        }
      }
      if (!this.match(10) && !this.match(0) && !this.match(16)) {
        this.raise(Errors.UnsupportedSuper, node);
      }
      return this.finishNode(node, "Super");
    }
    parsePrivateName() {
      const node = this.startNode();
      const id = this.startNodeAt(createPositionWithColumnOffset(this.state.startLoc, 1));
      const name = this.state.value;
      this.next();
      node.id = this.createIdentifier(id, name);
      return this.finishNode(node, "PrivateName");
    }
    parseFunctionOrFunctionSent() {
      const node = this.startNode();
      this.next();
      if (this.prodParam.hasYield && this.match(16)) {
        const meta = this.createIdentifier(this.startNodeAtNode(node), "function");
        this.next();
        if (this.match(103)) {
          this.expectPlugin("functionSent");
        } else if (!this.hasPlugin("functionSent")) {
          this.unexpected();
        }
        return this.parseMetaProperty(node, meta, "sent");
      }
      return this.parseFunction(node);
    }
    parseMetaProperty(node, meta, propertyName) {
      node.meta = meta;
      const containsEsc = this.state.containsEsc;
      node.property = this.parseIdentifier(true);
      if (node.property.name !== propertyName || containsEsc) {
        this.raise(Errors.UnsupportedMetaProperty, node.property, {
          target: meta.name,
          onlyValidPropertyName: propertyName
        });
      }
      return this.finishNode(node, "MetaProperty");
    }
    parseImportMetaPropertyOrPhaseCall(node) {
      this.next();
      if (this.isContextual(105) || this.isContextual(97)) {
        const isSource = this.isContextual(105);
        this.expectPlugin(isSource ? "sourcePhaseImports" : "deferredImportEvaluation");
        this.next();
        node.phase = isSource ? "source" : "defer";
        return this.parseImportCall(node);
      } else {
        const id = this.createIdentifierAt(this.startNodeAtNode(node), "import", this.state.lastTokStartLoc);
        if (this.isContextual(101)) {
          if (!this.inModule) {
            this.raise(Errors.ImportMetaOutsideModule, id);
          }
          this.sawUnambiguousESM = true;
        }
        return this.parseMetaProperty(node, id, "meta");
      }
    }
    parseLiteralAtNode(value, type, node) {
      this.addExtra(node, "rawValue", value);
      this.addExtra(node, "raw", this.input.slice(this.offsetToSourcePos(node.start), this.state.end));
      node.value = value;
      this.next();
      return this.finishNode(node, type);
    }
    parseLiteral(value, type) {
      const node = this.startNode();
      return this.parseLiteralAtNode(value, type, node);
    }
    parseStringLiteral(value) {
      return this.parseLiteral(value, "StringLiteral");
    }
    parseNumericLiteral(value) {
      return this.parseLiteral(value, "NumericLiteral");
    }
    parseBigIntLiteral(value) {
      return this.parseLiteral(value, "BigIntLiteral");
    }
    parseDecimalLiteral(value) {
      return this.parseLiteral(value, "DecimalLiteral");
    }
    parseRegExpLiteral(value) {
      const node = this.startNode();
      this.addExtra(node, "raw", this.input.slice(this.offsetToSourcePos(node.start), this.state.end));
      node.pattern = value.pattern;
      node.flags = value.flags;
      this.next();
      return this.finishNode(node, "RegExpLiteral");
    }
    parseBooleanLiteral(value) {
      const node = this.startNode();
      node.value = value;
      this.next();
      return this.finishNode(node, "BooleanLiteral");
    }
    parseNullLiteral() {
      const node = this.startNode();
      this.next();
      return this.finishNode(node, "NullLiteral");
    }
    parseParenAndDistinguishExpression(canBeArrow) {
      const startLoc = this.state.startLoc;
      let val;
      this.next();
      this.expressionScope.enter(newArrowHeadScope());
      const oldMaybeInArrowParameters = this.state.maybeInArrowParameters;
      const oldInFSharpPipelineDirectBody = this.state.inFSharpPipelineDirectBody;
      this.state.maybeInArrowParameters = true;
      this.state.inFSharpPipelineDirectBody = false;
      const innerStartLoc = this.state.startLoc;
      const exprList = [];
      const refExpressionErrors = new ExpressionErrors;
      let first = true;
      let spreadStartLoc;
      let optionalCommaStartLoc;
      while (!this.match(11)) {
        if (first) {
          first = false;
        } else {
          this.expect(12, refExpressionErrors.optionalParametersLoc === null ? null : refExpressionErrors.optionalParametersLoc);
          if (this.match(11)) {
            optionalCommaStartLoc = this.state.startLoc;
            break;
          }
        }
        if (this.match(21)) {
          const spreadNodeStartLoc = this.state.startLoc;
          spreadStartLoc = this.state.startLoc;
          exprList.push(this.parseParenItem(this.parseRestBinding(), spreadNodeStartLoc));
          if (!this.checkCommaAfterRest(41)) {
            break;
          }
        } else {
          exprList.push(this.parseMaybeAssignAllowInOrVoidPattern(11, refExpressionErrors, this.parseParenItem));
        }
      }
      const innerEndLoc = this.state.lastTokEndLoc;
      this.expect(11);
      this.state.maybeInArrowParameters = oldMaybeInArrowParameters;
      this.state.inFSharpPipelineDirectBody = oldInFSharpPipelineDirectBody;
      let arrowNode = this.startNodeAt(startLoc);
      if (canBeArrow && this.shouldParseArrow(exprList) && (arrowNode = this.parseArrow(arrowNode))) {
        this.checkDestructuringPrivate(refExpressionErrors);
        this.expressionScope.validateAsPattern();
        this.expressionScope.exit();
        this.parseArrowExpression(arrowNode, exprList, false);
        return arrowNode;
      }
      this.expressionScope.exit();
      if (!exprList.length) {
        this.unexpected(this.state.lastTokStartLoc);
      }
      if (optionalCommaStartLoc)
        this.unexpected(optionalCommaStartLoc);
      if (spreadStartLoc)
        this.unexpected(spreadStartLoc);
      this.checkExpressionErrors(refExpressionErrors, true);
      this.toReferencedListDeep(exprList, true);
      if (exprList.length > 1) {
        val = this.startNodeAt(innerStartLoc);
        val.expressions = exprList;
        this.finishNode(val, "SequenceExpression");
        this.resetEndLocation(val, innerEndLoc);
      } else {
        val = exprList[0];
      }
      return this.wrapParenthesis(startLoc, val);
    }
    wrapParenthesis(startLoc, expression) {
      if (!(this.optionFlags & 1024)) {
        this.addExtra(expression, "parenthesized", true);
        this.addExtra(expression, "parenStart", startLoc.index);
        this.takeSurroundingComments(expression, startLoc.index, this.state.lastTokEndLoc.index);
        return expression;
      }
      const parenExpression = this.startNodeAt(startLoc);
      parenExpression.expression = expression;
      return this.finishNode(parenExpression, "ParenthesizedExpression");
    }
    shouldParseArrow(params) {
      return !this.canInsertSemicolon();
    }
    parseArrow(node) {
      if (this.eat(19)) {
        return node;
      }
    }
    parseParenItem(node, startLoc) {
      return node;
    }
    parseNewOrNewTarget() {
      const node = this.startNode();
      this.next();
      if (this.match(16)) {
        const meta = this.createIdentifier(this.startNodeAtNode(node), "new");
        this.next();
        const metaProp = this.parseMetaProperty(node, meta, "target");
        if (!this.scope.allowNewTarget) {
          this.raise(Errors.UnexpectedNewTarget, metaProp);
        }
        return metaProp;
      }
      return this.parseNew(node);
    }
    parseNew(node) {
      this.parseNewCallee(node);
      if (this.eat(10)) {
        const args = this.parseExprList(11);
        this.toReferencedList(args);
        node.arguments = args;
      } else {
        node.arguments = [];
      }
      return this.finishNode(node, "NewExpression");
    }
    parseNewCallee(node) {
      const isImport = this.match(83);
      const callee = this.parseNoCallExpr();
      node.callee = callee;
      if (isImport && (callee.type === "Import" || callee.type === "ImportExpression")) {
        this.raise(Errors.ImportCallNotNewExpression, callee);
      }
    }
    parseTemplateElement(isTagged) {
      const {
        start,
        startLoc,
        end,
        value
      } = this.state;
      const elemStart = start + 1;
      const elem = this.startNodeAt(createPositionWithColumnOffset(startLoc, 1));
      if (value === null) {
        if (!isTagged) {
          this.raise(Errors.InvalidEscapeSequenceTemplate, createPositionWithColumnOffset(this.state.firstInvalidTemplateEscapePos, 1));
        }
      }
      const isTail = this.match(24);
      const endOffset = isTail ? -1 : -2;
      const elemEnd = end + endOffset;
      elem.value = {
        raw: this.input.slice(elemStart, elemEnd).replace(/\r\n?/g, `
`),
        cooked: value === null ? null : value.slice(1, endOffset)
      };
      elem.tail = isTail;
      this.next();
      const finishedNode = this.finishNode(elem, "TemplateElement");
      this.resetEndLocation(finishedNode, createPositionWithColumnOffset(this.state.lastTokEndLoc, endOffset));
      return finishedNode;
    }
    parseTemplate(isTagged) {
      const node = this.startNode();
      let curElt = this.parseTemplateElement(isTagged);
      const quasis = [curElt];
      const substitutions = [];
      while (!curElt.tail) {
        substitutions.push(this.parseTemplateSubstitution());
        this.readTemplateContinuation();
        quasis.push(curElt = this.parseTemplateElement(isTagged));
      }
      node.expressions = substitutions;
      node.quasis = quasis;
      return this.finishNode(node, "TemplateLiteral");
    }
    parseTemplateSubstitution() {
      return this.parseExpression();
    }
    parseObjectLike(close, isPattern, isRecord, refExpressionErrors) {
      if (isRecord) {
        this.expectPlugin("recordAndTuple");
      }
      const oldInFSharpPipelineDirectBody = this.state.inFSharpPipelineDirectBody;
      this.state.inFSharpPipelineDirectBody = false;
      let sawProto = false;
      let first = true;
      const node = this.startNode();
      node.properties = [];
      this.next();
      while (!this.match(close)) {
        if (first) {
          first = false;
        } else {
          this.expect(12);
          if (this.match(close)) {
            this.addTrailingCommaExtraToNode(node);
            break;
          }
        }
        let prop;
        if (isPattern) {
          prop = this.parseBindingProperty();
        } else {
          prop = this.parsePropertyDefinition(refExpressionErrors);
          sawProto = this.checkProto(prop, isRecord, sawProto, refExpressionErrors);
        }
        if (isRecord && !this.isObjectProperty(prop) && prop.type !== "SpreadElement") {
          this.raise(Errors.InvalidRecordProperty, prop);
        }
        if (prop.shorthand) {
          this.addExtra(prop, "shorthand", true);
        }
        node.properties.push(prop);
      }
      this.next();
      this.state.inFSharpPipelineDirectBody = oldInFSharpPipelineDirectBody;
      let type = "ObjectExpression";
      if (isPattern) {
        type = "ObjectPattern";
      } else if (isRecord) {
        type = "RecordExpression";
      }
      return this.finishNode(node, type);
    }
    addTrailingCommaExtraToNode(node) {
      this.addExtra(node, "trailingComma", this.state.lastTokStartLoc.index);
      this.addExtra(node, "trailingCommaLoc", this.state.lastTokStartLoc, false);
    }
    maybeAsyncOrAccessorProp(prop) {
      return !prop.computed && prop.key.type === "Identifier" && (this.isLiteralPropertyName() || this.match(0) || this.match(55));
    }
    parsePropertyDefinition(refExpressionErrors) {
      let decorators = [];
      if (this.match(26)) {
        if (this.hasPlugin("decorators")) {
          this.raise(Errors.UnsupportedPropertyDecorator, this.state.startLoc);
        }
        while (this.match(26)) {
          decorators.push(this.parseDecorator());
        }
      }
      const prop = this.startNode();
      let isAsync = false;
      let isAccessor = false;
      let startLoc;
      if (this.match(21)) {
        if (decorators.length)
          this.unexpected();
        return this.parseSpread();
      }
      if (decorators.length) {
        prop.decorators = decorators;
        decorators = [];
      }
      prop.method = false;
      if (refExpressionErrors) {
        startLoc = this.state.startLoc;
      }
      let isGenerator = this.eat(55);
      this.parsePropertyNamePrefixOperator(prop);
      const containsEsc = this.state.containsEsc;
      this.parsePropertyName(prop, refExpressionErrors);
      if (!isGenerator && !containsEsc && this.maybeAsyncOrAccessorProp(prop)) {
        const {
          key
        } = prop;
        const keyName = key.name;
        if (keyName === "async" && !this.hasPrecedingLineBreak()) {
          isAsync = true;
          this.resetPreviousNodeTrailingComments(key);
          isGenerator = this.eat(55);
          this.parsePropertyName(prop);
        }
        if (keyName === "get" || keyName === "set") {
          isAccessor = true;
          this.resetPreviousNodeTrailingComments(key);
          prop.kind = keyName;
          if (this.match(55)) {
            isGenerator = true;
            this.raise(Errors.AccessorIsGenerator, this.state.curPosition(), {
              kind: keyName
            });
            this.next();
          }
          this.parsePropertyName(prop);
        }
      }
      return this.parseObjPropValue(prop, startLoc, isGenerator, isAsync, false, isAccessor, refExpressionErrors);
    }
    getGetterSetterExpectedParamCount(method) {
      return method.kind === "get" ? 0 : 1;
    }
    getObjectOrClassMethodParams(method) {
      return method.params;
    }
    checkGetterSetterParams(method) {
      var _params;
      const paramCount = this.getGetterSetterExpectedParamCount(method);
      const params = this.getObjectOrClassMethodParams(method);
      if (params.length !== paramCount) {
        this.raise(method.kind === "get" ? Errors.BadGetterArity : Errors.BadSetterArity, method);
      }
      if (method.kind === "set" && ((_params = params[params.length - 1]) == null ? undefined : _params.type) === "RestElement") {
        this.raise(Errors.BadSetterRestParameter, method);
      }
    }
    parseObjectMethod(prop, isGenerator, isAsync, isPattern, isAccessor) {
      if (isAccessor) {
        const finishedProp = this.parseMethod(prop, isGenerator, false, false, false, "ObjectMethod");
        this.checkGetterSetterParams(finishedProp);
        return finishedProp;
      }
      if (isAsync || isGenerator || this.match(10)) {
        if (isPattern)
          this.unexpected();
        prop.kind = "method";
        prop.method = true;
        return this.parseMethod(prop, isGenerator, isAsync, false, false, "ObjectMethod");
      }
    }
    parseObjectProperty(prop, startLoc, isPattern, refExpressionErrors) {
      prop.shorthand = false;
      if (this.eat(14)) {
        prop.value = isPattern ? this.parseMaybeDefault(this.state.startLoc) : this.parseMaybeAssignAllowInOrVoidPattern(8, refExpressionErrors);
        return this.finishObjectProperty(prop);
      }
      if (!prop.computed && prop.key.type === "Identifier") {
        this.checkReservedWord(prop.key.name, prop.key.loc.start, true, false);
        if (isPattern) {
          prop.value = this.parseMaybeDefault(startLoc, this.cloneIdentifier(prop.key));
        } else if (this.match(29)) {
          const shorthandAssignLoc = this.state.startLoc;
          if (refExpressionErrors != null) {
            if (refExpressionErrors.shorthandAssignLoc === null) {
              refExpressionErrors.shorthandAssignLoc = shorthandAssignLoc;
            }
          } else {
            this.raise(Errors.InvalidCoverInitializedName, shorthandAssignLoc);
          }
          prop.value = this.parseMaybeDefault(startLoc, this.cloneIdentifier(prop.key));
        } else {
          prop.value = this.cloneIdentifier(prop.key);
        }
        prop.shorthand = true;
        return this.finishObjectProperty(prop);
      }
    }
    finishObjectProperty(node) {
      return this.finishNode(node, "ObjectProperty");
    }
    parseObjPropValue(prop, startLoc, isGenerator, isAsync, isPattern, isAccessor, refExpressionErrors) {
      const node = this.parseObjectMethod(prop, isGenerator, isAsync, isPattern, isAccessor) || this.parseObjectProperty(prop, startLoc, isPattern, refExpressionErrors);
      if (!node)
        this.unexpected();
      return node;
    }
    parsePropertyName(prop, refExpressionErrors) {
      if (this.eat(0)) {
        prop.computed = true;
        prop.key = this.parseMaybeAssignAllowIn();
        this.expect(3);
      } else {
        const {
          type,
          value
        } = this.state;
        let key;
        if (tokenIsKeywordOrIdentifier(type)) {
          key = this.parseIdentifier(true);
        } else {
          switch (type) {
            case 135:
              key = this.parseNumericLiteral(value);
              break;
            case 134:
              key = this.parseStringLiteral(value);
              break;
            case 136:
              key = this.parseBigIntLiteral(value);
              break;
            case 139: {
              const privateKeyLoc = this.state.startLoc;
              if (refExpressionErrors != null) {
                if (refExpressionErrors.privateKeyLoc === null) {
                  refExpressionErrors.privateKeyLoc = privateKeyLoc;
                }
              } else {
                this.raise(Errors.UnexpectedPrivateField, privateKeyLoc);
              }
              key = this.parsePrivateName();
              break;
            }
            default:
              if (type === 137) {
                key = this.parseDecimalLiteral(value);
                break;
              }
              this.unexpected();
          }
        }
        prop.key = key;
        if (type !== 139) {
          prop.computed = false;
        }
      }
    }
    initFunction(node, isAsync) {
      node.id = null;
      node.generator = false;
      node.async = isAsync;
    }
    parseMethod(node, isGenerator, isAsync, isConstructor, allowDirectSuper, type, inClassScope = false) {
      this.initFunction(node, isAsync);
      node.generator = isGenerator;
      this.scope.enter(514 | 16 | (inClassScope ? 576 : 0) | (allowDirectSuper ? 32 : 0));
      this.prodParam.enter(functionFlags(isAsync, node.generator));
      this.parseFunctionParams(node, isConstructor);
      const finishedNode = this.parseFunctionBodyAndFinish(node, type, true);
      this.prodParam.exit();
      this.scope.exit();
      return finishedNode;
    }
    parseArrayLike(close, isTuple, refExpressionErrors) {
      if (isTuple) {
        this.expectPlugin("recordAndTuple");
      }
      const oldInFSharpPipelineDirectBody = this.state.inFSharpPipelineDirectBody;
      this.state.inFSharpPipelineDirectBody = false;
      const node = this.startNode();
      this.next();
      node.elements = this.parseExprList(close, !isTuple, refExpressionErrors, node);
      this.state.inFSharpPipelineDirectBody = oldInFSharpPipelineDirectBody;
      return this.finishNode(node, isTuple ? "TupleExpression" : "ArrayExpression");
    }
    parseArrowExpression(node, params, isAsync, trailingCommaLoc) {
      this.scope.enter(514 | 4);
      let flags = functionFlags(isAsync, false);
      if (!this.match(5) && this.prodParam.hasIn) {
        flags |= 8;
      }
      this.prodParam.enter(flags);
      this.initFunction(node, isAsync);
      const oldMaybeInArrowParameters = this.state.maybeInArrowParameters;
      if (params) {
        this.state.maybeInArrowParameters = true;
        this.setArrowFunctionParameters(node, params, trailingCommaLoc);
      }
      this.state.maybeInArrowParameters = false;
      this.parseFunctionBody(node, true);
      this.prodParam.exit();
      this.scope.exit();
      this.state.maybeInArrowParameters = oldMaybeInArrowParameters;
      return this.finishNode(node, "ArrowFunctionExpression");
    }
    setArrowFunctionParameters(node, params, trailingCommaLoc) {
      this.toAssignableList(params, trailingCommaLoc, false);
      node.params = params;
    }
    parseFunctionBodyAndFinish(node, type, isMethod = false) {
      this.parseFunctionBody(node, false, isMethod);
      return this.finishNode(node, type);
    }
    parseFunctionBody(node, allowExpression, isMethod = false) {
      const isExpression = allowExpression && !this.match(5);
      this.expressionScope.enter(newExpressionScope());
      if (isExpression) {
        node.body = this.parseMaybeAssign();
        this.checkParams(node, false, allowExpression, false);
      } else {
        const oldStrict = this.state.strict;
        const oldLabels = this.state.labels;
        this.state.labels = [];
        this.prodParam.enter(this.prodParam.currentFlags() | 4);
        node.body = this.parseBlock(true, false, (hasStrictModeDirective) => {
          const nonSimple = !this.isSimpleParamList(node.params);
          if (hasStrictModeDirective && nonSimple) {
            this.raise(Errors.IllegalLanguageModeDirective, (node.kind === "method" || node.kind === "constructor") && !!node.key ? node.key.loc.end : node);
          }
          const strictModeChanged = !oldStrict && this.state.strict;
          this.checkParams(node, !this.state.strict && !allowExpression && !isMethod && !nonSimple, allowExpression, strictModeChanged);
          if (this.state.strict && node.id) {
            this.checkIdentifier(node.id, 65, strictModeChanged);
          }
        });
        this.prodParam.exit();
        this.state.labels = oldLabels;
      }
      this.expressionScope.exit();
    }
    isSimpleParameter(node) {
      return node.type === "Identifier";
    }
    isSimpleParamList(params) {
      for (let i = 0, len = params.length;i < len; i++) {
        if (!this.isSimpleParameter(params[i]))
          return false;
      }
      return true;
    }
    checkParams(node, allowDuplicates, isArrowFunction, strictModeChanged = true) {
      const checkClashes = !allowDuplicates && new Set;
      const formalParameters = {
        type: "FormalParameters"
      };
      for (const param of node.params) {
        this.checkLVal(param, formalParameters, 5, checkClashes, strictModeChanged);
      }
    }
    parseExprList(close, allowEmpty, refExpressionErrors, nodeForExtra) {
      const elts = [];
      let first = true;
      while (!this.eat(close)) {
        if (first) {
          first = false;
        } else {
          this.expect(12);
          if (this.match(close)) {
            if (nodeForExtra) {
              this.addTrailingCommaExtraToNode(nodeForExtra);
            }
            this.next();
            break;
          }
        }
        elts.push(this.parseExprListItem(close, allowEmpty, refExpressionErrors));
      }
      return elts;
    }
    parseExprListItem(close, allowEmpty, refExpressionErrors, allowPlaceholder) {
      let elt;
      if (this.match(12)) {
        if (!allowEmpty) {
          this.raise(Errors.UnexpectedToken, this.state.curPosition(), {
            unexpected: ","
          });
        }
        elt = null;
      } else if (this.match(21)) {
        const spreadNodeStartLoc = this.state.startLoc;
        elt = this.parseParenItem(this.parseSpread(refExpressionErrors), spreadNodeStartLoc);
      } else if (this.match(17)) {
        this.expectPlugin("partialApplication");
        if (!allowPlaceholder) {
          this.raise(Errors.UnexpectedArgumentPlaceholder, this.state.startLoc);
        }
        const node = this.startNode();
        this.next();
        elt = this.finishNode(node, "ArgumentPlaceholder");
      } else {
        elt = this.parseMaybeAssignAllowInOrVoidPattern(close, refExpressionErrors, this.parseParenItem);
      }
      return elt;
    }
    parseIdentifier(liberal) {
      const node = this.startNode();
      const name = this.parseIdentifierName(liberal);
      return this.createIdentifier(node, name);
    }
    createIdentifier(node, name) {
      node.name = name;
      node.loc.identifierName = name;
      return this.finishNode(node, "Identifier");
    }
    createIdentifierAt(node, name, endLoc) {
      node.name = name;
      node.loc.identifierName = name;
      return this.finishNodeAt(node, "Identifier", endLoc);
    }
    parseIdentifierName(liberal) {
      let name;
      const {
        startLoc,
        type
      } = this.state;
      if (tokenIsKeywordOrIdentifier(type)) {
        name = this.state.value;
      } else {
        this.unexpected();
      }
      const tokenIsKeyword2 = tokenKeywordOrIdentifierIsKeyword(type);
      if (liberal) {
        if (tokenIsKeyword2) {
          this.replaceToken(132);
        }
      } else {
        this.checkReservedWord(name, startLoc, tokenIsKeyword2, false);
      }
      this.next();
      return name;
    }
    checkReservedWord(word, startLoc, checkKeywords, isBinding) {
      if (word.length > 10) {
        return;
      }
      if (!canBeReservedWord(word)) {
        return;
      }
      if (checkKeywords && isKeyword(word)) {
        this.raise(Errors.UnexpectedKeyword, startLoc, {
          keyword: word
        });
        return;
      }
      const reservedTest = !this.state.strict ? isReservedWord : isBinding ? isStrictBindReservedWord : isStrictReservedWord;
      if (reservedTest(word, this.inModule)) {
        this.raise(Errors.UnexpectedReservedWord, startLoc, {
          reservedWord: word
        });
        return;
      } else if (word === "yield") {
        if (this.prodParam.hasYield) {
          this.raise(Errors.YieldBindingIdentifier, startLoc);
          return;
        }
      } else if (word === "await") {
        if (this.prodParam.hasAwait) {
          this.raise(Errors.AwaitBindingIdentifier, startLoc);
          return;
        }
        if (this.scope.inStaticBlock) {
          this.raise(Errors.AwaitBindingIdentifierInStaticBlock, startLoc);
          return;
        }
        this.expressionScope.recordAsyncArrowParametersError(startLoc);
      } else if (word === "arguments") {
        if (this.scope.inClassAndNotInNonArrowFunction) {
          this.raise(Errors.ArgumentsInClass, startLoc);
          return;
        }
      }
    }
    recordAwaitIfAllowed() {
      const isAwaitAllowed = this.prodParam.hasAwait;
      if (isAwaitAllowed && !this.scope.inFunction) {
        this.state.hasTopLevelAwait = true;
      }
      return isAwaitAllowed;
    }
    parseAwait(startLoc) {
      const node = this.startNodeAt(startLoc);
      this.expressionScope.recordParameterInitializerError(Errors.AwaitExpressionFormalParameter, node);
      if (this.eat(55)) {
        this.raise(Errors.ObsoleteAwaitStar, node);
      }
      if (!this.scope.inFunction && !(this.optionFlags & 1)) {
        if (this.isAmbiguousPrefixOrIdentifier()) {
          this.ambiguousScriptDifferentAst = true;
        } else {
          this.sawUnambiguousESM = true;
        }
      }
      if (!this.state.soloAwait) {
        node.argument = this.parseMaybeUnary(null, true);
      }
      return this.finishNode(node, "AwaitExpression");
    }
    isAmbiguousPrefixOrIdentifier() {
      if (this.hasPrecedingLineBreak())
        return true;
      const {
        type
      } = this.state;
      return type === 53 || type === 10 || type === 0 || tokenIsTemplate(type) || type === 102 && !this.state.containsEsc || type === 138 || type === 56 || this.hasPlugin("v8intrinsic") && type === 54;
    }
    parseYield(startLoc) {
      const node = this.startNodeAt(startLoc);
      this.expressionScope.recordParameterInitializerError(Errors.YieldInParameter, node);
      let delegating = false;
      let argument = null;
      if (!this.hasPrecedingLineBreak()) {
        delegating = this.eat(55);
        switch (this.state.type) {
          case 13:
          case 140:
          case 8:
          case 11:
          case 3:
          case 9:
          case 14:
          case 12:
            if (!delegating)
              break;
          default:
            argument = this.parseMaybeAssign();
        }
      }
      node.delegate = delegating;
      node.argument = argument;
      return this.finishNode(node, "YieldExpression");
    }
    parseImportCall(node) {
      this.next();
      node.source = this.parseMaybeAssignAllowIn();
      node.options = null;
      if (this.eat(12)) {
        if (!this.match(11)) {
          node.options = this.parseMaybeAssignAllowIn();
          if (this.eat(12)) {
            this.addTrailingCommaExtraToNode(node.options);
            if (!this.match(11)) {
              do {
                this.parseMaybeAssignAllowIn();
              } while (this.eat(12) && !this.match(11));
              this.raise(Errors.ImportCallArity, node);
            }
          }
        } else {
          this.addTrailingCommaExtraToNode(node.source);
        }
      }
      this.expect(11);
      return this.finishNode(node, "ImportExpression");
    }
    checkPipelineAtInfixOperator(left, leftStartLoc) {
      if (this.hasPlugin(["pipelineOperator", {
        proposal: "smart"
      }])) {
        if (left.type === "SequenceExpression") {
          this.raise(Errors.PipelineHeadSequenceExpression, leftStartLoc);
        }
      }
    }
    parseSmartPipelineBodyInStyle(childExpr, startLoc) {
      if (this.isSimpleReference(childExpr)) {
        const bodyNode = this.startNodeAt(startLoc);
        bodyNode.callee = childExpr;
        return this.finishNode(bodyNode, "PipelineBareFunction");
      } else {
        const bodyNode = this.startNodeAt(startLoc);
        this.checkSmartPipeTopicBodyEarlyErrors(startLoc);
        bodyNode.expression = childExpr;
        return this.finishNode(bodyNode, "PipelineTopicExpression");
      }
    }
    isSimpleReference(expression) {
      switch (expression.type) {
        case "MemberExpression":
          return !expression.computed && this.isSimpleReference(expression.object);
        case "Identifier":
          return true;
        default:
          return false;
      }
    }
    checkSmartPipeTopicBodyEarlyErrors(startLoc) {
      if (this.match(19)) {
        throw this.raise(Errors.PipelineBodyNoArrow, this.state.startLoc);
      }
      if (!this.topicReferenceWasUsedInCurrentContext()) {
        this.raise(Errors.PipelineTopicUnused, startLoc);
      }
    }
    withTopicBindingContext(callback) {
      const outerContextTopicState = this.state.topicContext;
      this.state.topicContext = {
        maxNumOfResolvableTopics: 1,
        maxTopicIndex: null
      };
      try {
        return callback();
      } finally {
        this.state.topicContext = outerContextTopicState;
      }
    }
    withSmartMixTopicForbiddingContext(callback) {
      if (this.hasPlugin(["pipelineOperator", {
        proposal: "smart"
      }])) {
        const outerContextTopicState = this.state.topicContext;
        this.state.topicContext = {
          maxNumOfResolvableTopics: 0,
          maxTopicIndex: null
        };
        try {
          return callback();
        } finally {
          this.state.topicContext = outerContextTopicState;
        }
      } else {
        return callback();
      }
    }
    withSoloAwaitPermittingContext(callback) {
      const outerContextSoloAwaitState = this.state.soloAwait;
      this.state.soloAwait = true;
      try {
        return callback();
      } finally {
        this.state.soloAwait = outerContextSoloAwaitState;
      }
    }
    allowInAnd(callback) {
      const flags = this.prodParam.currentFlags();
      const prodParamToSet = 8 & ~flags;
      if (prodParamToSet) {
        this.prodParam.enter(flags | 8);
        try {
          return callback();
        } finally {
          this.prodParam.exit();
        }
      }
      return callback();
    }
    disallowInAnd(callback) {
      const flags = this.prodParam.currentFlags();
      const prodParamToClear = 8 & flags;
      if (prodParamToClear) {
        this.prodParam.enter(flags & ~8);
        try {
          return callback();
        } finally {
          this.prodParam.exit();
        }
      }
      return callback();
    }
    registerTopicReference() {
      this.state.topicContext.maxTopicIndex = 0;
    }
    topicReferenceIsAllowedInCurrentContext() {
      return this.state.topicContext.maxNumOfResolvableTopics >= 1;
    }
    topicReferenceWasUsedInCurrentContext() {
      return this.state.topicContext.maxTopicIndex != null && this.state.topicContext.maxTopicIndex >= 0;
    }
    parseFSharpPipelineBody(prec) {
      const startLoc = this.state.startLoc;
      this.state.potentialArrowAt = this.state.start;
      const oldInFSharpPipelineDirectBody = this.state.inFSharpPipelineDirectBody;
      this.state.inFSharpPipelineDirectBody = true;
      const ret = this.parseExprOp(this.parseMaybeUnaryOrPrivate(), startLoc, prec);
      this.state.inFSharpPipelineDirectBody = oldInFSharpPipelineDirectBody;
      return ret;
    }
    parseModuleExpression() {
      this.expectPlugin("moduleBlocks");
      const node = this.startNode();
      this.next();
      if (!this.match(5)) {
        this.unexpected(null, 5);
      }
      const program = this.startNodeAt(this.state.endLoc);
      this.next();
      const revertScopes = this.initializeScopes(true);
      this.enterInitialScopes();
      try {
        node.body = this.parseProgram(program, 8, "module");
      } finally {
        revertScopes();
      }
      return this.finishNode(node, "ModuleExpression");
    }
    parseVoidPattern(refExpressionErrors) {
      this.expectPlugin("discardBinding");
      const node = this.startNode();
      if (refExpressionErrors != null) {
        refExpressionErrors.voidPatternLoc = this.state.startLoc;
      }
      this.next();
      return this.finishNode(node, "VoidPattern");
    }
    parseMaybeAssignAllowInOrVoidPattern(close, refExpressionErrors, afterLeftParse) {
      if (refExpressionErrors != null && this.match(88)) {
        const nextCode = this.lookaheadCharCode();
        if (nextCode === 44 || nextCode === (close === 3 ? 93 : close === 8 ? 125 : 41) || nextCode === 61) {
          return this.parseMaybeDefault(this.state.startLoc, this.parseVoidPattern(refExpressionErrors));
        }
      }
      return this.parseMaybeAssignAllowIn(refExpressionErrors, afterLeftParse);
    }
    parsePropertyNamePrefixOperator(prop) {}
  }
  var loopLabel = {
    kind: 1
  };
  var switchLabel = {
    kind: 2
  };
  var loneSurrogate = /[\uD800-\uDFFF]/u;
  var keywordRelationalOperator = /in(?:stanceof)?/y;
  function babel7CompatTokens(tokens, input, startIndex) {
    for (let i = 0;i < tokens.length; i++) {
      const token = tokens[i];
      const {
        type
      } = token;
      if (typeof type === "number") {
        if (type === 139) {
          const {
            loc,
            start,
            value,
            end
          } = token;
          const hashEndPos = start + 1;
          const hashEndLoc = createPositionWithColumnOffset(loc.start, 1);
          tokens.splice(i, 1, new Token({
            type: getExportedToken(27),
            value: "#",
            start,
            end: hashEndPos,
            startLoc: loc.start,
            endLoc: hashEndLoc
          }), new Token({
            type: getExportedToken(132),
            value,
            start: hashEndPos,
            end,
            startLoc: hashEndLoc,
            endLoc: loc.end
          }));
          i++;
          continue;
        }
        if (tokenIsTemplate(type)) {
          const {
            loc,
            start,
            value,
            end
          } = token;
          const backquoteEnd = start + 1;
          const backquoteEndLoc = createPositionWithColumnOffset(loc.start, 1);
          let startToken;
          if (input.charCodeAt(start - startIndex) === 96) {
            startToken = new Token({
              type: getExportedToken(22),
              value: "`",
              start,
              end: backquoteEnd,
              startLoc: loc.start,
              endLoc: backquoteEndLoc
            });
          } else {
            startToken = new Token({
              type: getExportedToken(8),
              value: "}",
              start,
              end: backquoteEnd,
              startLoc: loc.start,
              endLoc: backquoteEndLoc
            });
          }
          let templateValue, templateElementEnd, templateElementEndLoc, endToken;
          if (type === 24) {
            templateElementEnd = end - 1;
            templateElementEndLoc = createPositionWithColumnOffset(loc.end, -1);
            templateValue = value === null ? null : value.slice(1, -1);
            endToken = new Token({
              type: getExportedToken(22),
              value: "`",
              start: templateElementEnd,
              end,
              startLoc: templateElementEndLoc,
              endLoc: loc.end
            });
          } else {
            templateElementEnd = end - 2;
            templateElementEndLoc = createPositionWithColumnOffset(loc.end, -2);
            templateValue = value === null ? null : value.slice(1, -2);
            endToken = new Token({
              type: getExportedToken(23),
              value: "${",
              start: templateElementEnd,
              end,
              startLoc: templateElementEndLoc,
              endLoc: loc.end
            });
          }
          tokens.splice(i, 1, startToken, new Token({
            type: getExportedToken(20),
            value: templateValue,
            start: backquoteEnd,
            end: templateElementEnd,
            startLoc: backquoteEndLoc,
            endLoc: templateElementEndLoc
          }), endToken);
          i += 2;
          continue;
        }
        token.type = getExportedToken(type);
      }
    }
    return tokens;
  }

  class StatementParser extends ExpressionParser {
    parseTopLevel(file, program) {
      file.program = this.parseProgram(program, 140, this.options.sourceType === "module" ? "module" : "script");
      file.comments = this.comments;
      if (this.optionFlags & 256) {
        file.tokens = babel7CompatTokens(this.tokens, this.input, this.startIndex);
      }
      return this.finishNode(file, "File");
    }
    parseProgram(program, end, sourceType) {
      program.sourceType = sourceType;
      program.interpreter = this.parseInterpreterDirective();
      this.parseBlockBody(program, true, true, end);
      if (this.inModule) {
        if (!(this.optionFlags & 64) && this.scope.undefinedExports.size > 0) {
          for (const [localName, at] of Array.from(this.scope.undefinedExports)) {
            this.raise(Errors.ModuleExportUndefined, at, {
              localName
            });
          }
        }
        this.addExtra(program, "topLevelAwait", this.state.hasTopLevelAwait);
      }
      let finishedProgram;
      if (end === 140) {
        finishedProgram = this.finishNode(program, "Program");
      } else {
        finishedProgram = this.finishNodeAt(program, "Program", createPositionWithColumnOffset(this.state.startLoc, -1));
      }
      return finishedProgram;
    }
    stmtToDirective(stmt) {
      const directive = this.castNodeTo(stmt, "Directive");
      const directiveLiteral = this.castNodeTo(stmt.expression, "DirectiveLiteral");
      const expressionValue = directiveLiteral.value;
      const raw = this.input.slice(this.offsetToSourcePos(directiveLiteral.start), this.offsetToSourcePos(directiveLiteral.end));
      const val = directiveLiteral.value = raw.slice(1, -1);
      this.addExtra(directiveLiteral, "raw", raw);
      this.addExtra(directiveLiteral, "rawValue", val);
      this.addExtra(directiveLiteral, "expressionValue", expressionValue);
      directive.value = directiveLiteral;
      delete stmt.expression;
      return directive;
    }
    parseInterpreterDirective() {
      if (!this.match(28)) {
        return null;
      }
      const node = this.startNode();
      node.value = this.state.value;
      this.next();
      return this.finishNode(node, "InterpreterDirective");
    }
    isLet() {
      if (!this.isContextual(100)) {
        return false;
      }
      return this.hasFollowingBindingAtom();
    }
    isUsing() {
      if (!this.isContextual(107)) {
        return false;
      }
      return this.nextTokenIsIdentifierOnSameLine();
    }
    isForUsing() {
      if (!this.isContextual(107)) {
        return false;
      }
      const next = this.nextTokenInLineStart();
      const nextCh = this.codePointAtPos(next);
      if (this.isUnparsedContextual(next, "of")) {
        const nextCharAfterOf = this.lookaheadCharCodeSince(next + 2);
        if (nextCharAfterOf !== 61 && nextCharAfterOf !== 58 && nextCharAfterOf !== 59) {
          return false;
        }
      }
      if (this.chStartsBindingIdentifier(nextCh, next) || this.isUnparsedContextual(next, "void")) {
        return true;
      }
      return false;
    }
    nextTokenIsIdentifierOnSameLine() {
      const next = this.nextTokenInLineStart();
      const nextCh = this.codePointAtPos(next);
      return this.chStartsBindingIdentifier(nextCh, next);
    }
    isAwaitUsing() {
      if (!this.isContextual(96)) {
        return false;
      }
      let next = this.nextTokenInLineStart();
      if (this.isUnparsedContextual(next, "using")) {
        next = this.nextTokenInLineStartSince(next + 5);
        const nextCh = this.codePointAtPos(next);
        if (this.chStartsBindingIdentifier(nextCh, next)) {
          return true;
        }
      }
      return false;
    }
    chStartsBindingIdentifier(ch, pos) {
      if (isIdentifierStart(ch)) {
        keywordRelationalOperator.lastIndex = pos;
        if (keywordRelationalOperator.test(this.input)) {
          const endCh = this.codePointAtPos(keywordRelationalOperator.lastIndex);
          if (!isIdentifierChar(endCh) && endCh !== 92) {
            return false;
          }
        }
        return true;
      } else if (ch === 92) {
        return true;
      } else {
        return false;
      }
    }
    chStartsBindingPattern(ch) {
      return ch === 91 || ch === 123;
    }
    hasFollowingBindingAtom() {
      const next = this.nextTokenStart();
      const nextCh = this.codePointAtPos(next);
      return this.chStartsBindingPattern(nextCh) || this.chStartsBindingIdentifier(nextCh, next);
    }
    hasInLineFollowingBindingIdentifierOrBrace() {
      const next = this.nextTokenInLineStart();
      const nextCh = this.codePointAtPos(next);
      return nextCh === 123 || this.chStartsBindingIdentifier(nextCh, next);
    }
    allowsUsing() {
      return (this.scope.inModule || !this.scope.inTopLevel) && !this.scope.inBareCaseStatement;
    }
    parseModuleItem() {
      return this.parseStatementLike(1 | 2 | 4 | 8);
    }
    parseStatementListItem() {
      return this.parseStatementLike(2 | 4 | (!this.options.annexB || this.state.strict ? 0 : 8));
    }
    parseStatementOrSloppyAnnexBFunctionDeclaration(allowLabeledFunction = false) {
      let flags = 0;
      if (this.options.annexB && !this.state.strict) {
        flags |= 4;
        if (allowLabeledFunction) {
          flags |= 8;
        }
      }
      return this.parseStatementLike(flags);
    }
    parseStatement() {
      return this.parseStatementLike(0);
    }
    parseStatementLike(flags) {
      let decorators = null;
      if (this.match(26)) {
        decorators = this.parseDecorators(true);
      }
      return this.parseStatementContent(flags, decorators);
    }
    parseStatementContent(flags, decorators) {
      const startType = this.state.type;
      const node = this.startNode();
      const allowDeclaration = !!(flags & 2);
      const allowFunctionDeclaration = !!(flags & 4);
      const topLevel = flags & 1;
      switch (startType) {
        case 60:
          return this.parseBreakContinueStatement(node, true);
        case 63:
          return this.parseBreakContinueStatement(node, false);
        case 64:
          return this.parseDebuggerStatement(node);
        case 90:
          return this.parseDoWhileStatement(node);
        case 91:
          return this.parseForStatement(node);
        case 68:
          if (this.lookaheadCharCode() === 46)
            break;
          if (!allowFunctionDeclaration) {
            this.raise(this.state.strict ? Errors.StrictFunction : this.options.annexB ? Errors.SloppyFunctionAnnexB : Errors.SloppyFunction, this.state.startLoc);
          }
          return this.parseFunctionStatement(node, false, !allowDeclaration && allowFunctionDeclaration);
        case 80:
          if (!allowDeclaration)
            this.unexpected();
          return this.parseClass(this.maybeTakeDecorators(decorators, node), true);
        case 69:
          return this.parseIfStatement(node);
        case 70:
          return this.parseReturnStatement(node);
        case 71:
          return this.parseSwitchStatement(node);
        case 72:
          return this.parseThrowStatement(node);
        case 73:
          return this.parseTryStatement(node);
        case 96:
          if (this.isAwaitUsing()) {
            if (!this.allowsUsing()) {
              this.raise(Errors.UnexpectedUsingDeclaration, node);
            } else if (!allowDeclaration) {
              this.raise(Errors.UnexpectedLexicalDeclaration, node);
            } else if (!this.recordAwaitIfAllowed()) {
              this.raise(Errors.AwaitUsingNotInAsyncContext, node);
            }
            this.next();
            return this.parseVarStatement(node, "await using");
          }
          break;
        case 107:
          if (this.state.containsEsc || !this.hasInLineFollowingBindingIdentifierOrBrace()) {
            break;
          }
          if (!this.allowsUsing()) {
            this.raise(Errors.UnexpectedUsingDeclaration, this.state.startLoc);
          } else if (!allowDeclaration) {
            this.raise(Errors.UnexpectedLexicalDeclaration, this.state.startLoc);
          }
          return this.parseVarStatement(node, "using");
        case 100: {
          if (this.state.containsEsc) {
            break;
          }
          const next = this.nextTokenStart();
          const nextCh = this.codePointAtPos(next);
          if (nextCh !== 91) {
            if (!allowDeclaration && this.hasFollowingLineBreak())
              break;
            if (!this.chStartsBindingIdentifier(nextCh, next) && nextCh !== 123) {
              break;
            }
          }
        }
        case 75: {
          if (!allowDeclaration) {
            this.raise(Errors.UnexpectedLexicalDeclaration, this.state.startLoc);
          }
        }
        case 74: {
          const kind = this.state.value;
          return this.parseVarStatement(node, kind);
        }
        case 92:
          return this.parseWhileStatement(node);
        case 76:
          return this.parseWithStatement(node);
        case 5:
          return this.parseBlock();
        case 13:
          return this.parseEmptyStatement(node);
        case 83: {
          const nextTokenCharCode = this.lookaheadCharCode();
          if (nextTokenCharCode === 40 || nextTokenCharCode === 46) {
            break;
          }
        }
        case 82: {
          if (!(this.optionFlags & 8) && !topLevel) {
            this.raise(Errors.UnexpectedImportExport, this.state.startLoc);
          }
          this.next();
          let result;
          if (startType === 83) {
            result = this.parseImport(node);
          } else {
            result = this.parseExport(node, decorators);
          }
          this.assertModuleNodeAllowed(result);
          return result;
        }
        default: {
          if (this.isAsyncFunction()) {
            if (!allowDeclaration) {
              this.raise(Errors.AsyncFunctionInSingleStatementContext, this.state.startLoc);
            }
            this.next();
            return this.parseFunctionStatement(node, true, !allowDeclaration && allowFunctionDeclaration);
          }
        }
      }
      const maybeName = this.state.value;
      const expr = this.parseExpression();
      if (tokenIsIdentifier(startType) && expr.type === "Identifier" && this.eat(14)) {
        return this.parseLabeledStatement(node, maybeName, expr, flags);
      } else {
        return this.parseExpressionStatement(node, expr, decorators);
      }
    }
    assertModuleNodeAllowed(node) {
      if (!(this.optionFlags & 8) && !this.inModule) {
        this.raise(Errors.ImportOutsideModule, node);
      }
    }
    decoratorsEnabledBeforeExport() {
      if (this.hasPlugin("decorators-legacy"))
        return true;
      return this.hasPlugin("decorators") && this.getPluginOption("decorators", "decoratorsBeforeExport") !== false;
    }
    maybeTakeDecorators(maybeDecorators, classNode, exportNode) {
      if (maybeDecorators) {
        var _classNode$decorators;
        if ((_classNode$decorators = classNode.decorators) != null && _classNode$decorators.length) {
          if (typeof this.getPluginOption("decorators", "decoratorsBeforeExport") !== "boolean") {
            this.raise(Errors.DecoratorsBeforeAfterExport, classNode.decorators[0]);
          }
          classNode.decorators.unshift(...maybeDecorators);
        } else {
          classNode.decorators = maybeDecorators;
        }
        this.resetStartLocationFromNode(classNode, maybeDecorators[0]);
        if (exportNode)
          this.resetStartLocationFromNode(exportNode, classNode);
      }
      return classNode;
    }
    canHaveLeadingDecorator() {
      return this.match(80);
    }
    parseDecorators(allowExport) {
      const decorators = [];
      do {
        decorators.push(this.parseDecorator());
      } while (this.match(26));
      if (this.match(82)) {
        if (!allowExport) {
          this.unexpected();
        }
        if (!this.decoratorsEnabledBeforeExport()) {
          this.raise(Errors.DecoratorExportClass, this.state.startLoc);
        }
      } else if (!this.canHaveLeadingDecorator()) {
        throw this.raise(Errors.UnexpectedLeadingDecorator, this.state.startLoc);
      }
      return decorators;
    }
    parseDecorator() {
      this.expectOnePlugin(["decorators", "decorators-legacy"]);
      const node = this.startNode();
      this.next();
      if (this.hasPlugin("decorators")) {
        const startLoc = this.state.startLoc;
        let expr;
        if (this.match(10)) {
          const startLoc2 = this.state.startLoc;
          this.next();
          expr = this.parseExpression();
          this.expect(11);
          expr = this.wrapParenthesis(startLoc2, expr);
          const paramsStartLoc = this.state.startLoc;
          node.expression = this.parseMaybeDecoratorArguments(expr, startLoc2);
          if (this.getPluginOption("decorators", "allowCallParenthesized") === false && node.expression !== expr) {
            this.raise(Errors.DecoratorArgumentsOutsideParentheses, paramsStartLoc);
          }
        } else {
          expr = this.parseIdentifier(false);
          while (this.eat(16)) {
            const node2 = this.startNodeAt(startLoc);
            node2.object = expr;
            if (this.match(139)) {
              this.classScope.usePrivateName(this.state.value, this.state.startLoc);
              node2.property = this.parsePrivateName();
            } else {
              node2.property = this.parseIdentifier(true);
            }
            node2.computed = false;
            expr = this.finishNode(node2, "MemberExpression");
          }
          node.expression = this.parseMaybeDecoratorArguments(expr, startLoc);
        }
      } else {
        node.expression = this.parseExprSubscripts();
      }
      return this.finishNode(node, "Decorator");
    }
    parseMaybeDecoratorArguments(expr, startLoc) {
      if (this.eat(10)) {
        const node = this.startNodeAt(startLoc);
        node.callee = expr;
        node.arguments = this.parseCallExpressionArguments();
        this.toReferencedList(node.arguments);
        return this.finishNode(node, "CallExpression");
      }
      return expr;
    }
    parseBreakContinueStatement(node, isBreak) {
      this.next();
      if (this.isLineTerminator()) {
        node.label = null;
      } else {
        node.label = this.parseIdentifier();
        this.semicolon();
      }
      this.verifyBreakContinue(node, isBreak);
      return this.finishNode(node, isBreak ? "BreakStatement" : "ContinueStatement");
    }
    verifyBreakContinue(node, isBreak) {
      let i;
      for (i = 0;i < this.state.labels.length; ++i) {
        const lab = this.state.labels[i];
        if (node.label == null || lab.name === node.label.name) {
          if (lab.kind != null && (isBreak || lab.kind === 1)) {
            break;
          }
          if (node.label && isBreak)
            break;
        }
      }
      if (i === this.state.labels.length) {
        const type = isBreak ? "BreakStatement" : "ContinueStatement";
        this.raise(Errors.IllegalBreakContinue, node, {
          type
        });
      }
    }
    parseDebuggerStatement(node) {
      this.next();
      this.semicolon();
      return this.finishNode(node, "DebuggerStatement");
    }
    parseHeaderExpression() {
      this.expect(10);
      const val = this.parseExpression();
      this.expect(11);
      return val;
    }
    parseDoWhileStatement(node) {
      this.next();
      this.state.labels.push(loopLabel);
      node.body = this.withSmartMixTopicForbiddingContext(() => this.parseStatement());
      this.state.labels.pop();
      this.expect(92);
      node.test = this.parseHeaderExpression();
      this.eat(13);
      return this.finishNode(node, "DoWhileStatement");
    }
    parseForStatement(node) {
      this.next();
      this.state.labels.push(loopLabel);
      let awaitAt = null;
      if (this.isContextual(96) && this.recordAwaitIfAllowed()) {
        awaitAt = this.state.startLoc;
        this.next();
      }
      this.scope.enter(0);
      this.expect(10);
      if (this.match(13)) {
        if (awaitAt !== null) {
          this.unexpected(awaitAt);
        }
        return this.parseFor(node, null);
      }
      const startsWithLet = this.isContextual(100);
      {
        const startsWithAwaitUsing = this.isAwaitUsing();
        const starsWithUsingDeclaration = startsWithAwaitUsing || this.isForUsing();
        const isLetOrUsing = startsWithLet && this.hasFollowingBindingAtom() || starsWithUsingDeclaration;
        if (this.match(74) || this.match(75) || isLetOrUsing) {
          const initNode = this.startNode();
          let kind;
          if (startsWithAwaitUsing) {
            kind = "await using";
            if (!this.recordAwaitIfAllowed()) {
              this.raise(Errors.AwaitUsingNotInAsyncContext, this.state.startLoc);
            }
            this.next();
          } else {
            kind = this.state.value;
          }
          this.next();
          this.parseVar(initNode, true, kind);
          const init2 = this.finishNode(initNode, "VariableDeclaration");
          const isForIn = this.match(58);
          if (isForIn && starsWithUsingDeclaration) {
            this.raise(Errors.ForInUsing, init2);
          }
          if ((isForIn || this.isContextual(102)) && init2.declarations.length === 1) {
            return this.parseForIn(node, init2, awaitAt);
          }
          if (awaitAt !== null) {
            this.unexpected(awaitAt);
          }
          return this.parseFor(node, init2);
        }
      }
      const startsWithAsync = this.isContextual(95);
      const refExpressionErrors = new ExpressionErrors;
      const init = this.parseExpression(true, refExpressionErrors);
      const isForOf = this.isContextual(102);
      if (isForOf) {
        if (startsWithLet) {
          this.raise(Errors.ForOfLet, init);
        }
        if (awaitAt === null && startsWithAsync && init.type === "Identifier") {
          this.raise(Errors.ForOfAsync, init);
        }
      }
      if (isForOf || this.match(58)) {
        this.checkDestructuringPrivate(refExpressionErrors);
        this.toAssignable(init, true);
        const type = isForOf ? "ForOfStatement" : "ForInStatement";
        this.checkLVal(init, {
          type
        });
        return this.parseForIn(node, init, awaitAt);
      } else {
        this.checkExpressionErrors(refExpressionErrors, true);
      }
      if (awaitAt !== null) {
        this.unexpected(awaitAt);
      }
      return this.parseFor(node, init);
    }
    parseFunctionStatement(node, isAsync, isHangingDeclaration) {
      this.next();
      return this.parseFunction(node, 1 | (isHangingDeclaration ? 2 : 0) | (isAsync ? 8 : 0));
    }
    parseIfStatement(node) {
      this.next();
      node.test = this.parseHeaderExpression();
      node.consequent = this.parseStatementOrSloppyAnnexBFunctionDeclaration();
      node.alternate = this.eat(66) ? this.parseStatementOrSloppyAnnexBFunctionDeclaration() : null;
      return this.finishNode(node, "IfStatement");
    }
    parseReturnStatement(node) {
      if (!this.prodParam.hasReturn) {
        this.raise(Errors.IllegalReturn, this.state.startLoc);
      }
      this.next();
      if (this.isLineTerminator()) {
        node.argument = null;
      } else {
        node.argument = this.parseExpression();
        this.semicolon();
      }
      return this.finishNode(node, "ReturnStatement");
    }
    parseSwitchStatement(node) {
      this.next();
      node.discriminant = this.parseHeaderExpression();
      const cases = node.cases = [];
      this.expect(5);
      this.state.labels.push(switchLabel);
      this.scope.enter(256);
      let cur;
      for (let sawDefault;!this.match(8); ) {
        if (this.match(61) || this.match(65)) {
          const isCase = this.match(61);
          if (cur)
            this.finishNode(cur, "SwitchCase");
          cases.push(cur = this.startNode());
          cur.consequent = [];
          this.next();
          if (isCase) {
            cur.test = this.parseExpression();
          } else {
            if (sawDefault) {
              this.raise(Errors.MultipleDefaultsInSwitch, this.state.lastTokStartLoc);
            }
            sawDefault = true;
            cur.test = null;
          }
          this.expect(14);
        } else {
          if (cur) {
            cur.consequent.push(this.parseStatementListItem());
          } else {
            this.unexpected();
          }
        }
      }
      this.scope.exit();
      if (cur)
        this.finishNode(cur, "SwitchCase");
      this.next();
      this.state.labels.pop();
      return this.finishNode(node, "SwitchStatement");
    }
    parseThrowStatement(node) {
      this.next();
      if (this.hasPrecedingLineBreak()) {
        this.raise(Errors.NewlineAfterThrow, this.state.lastTokEndLoc);
      }
      node.argument = this.parseExpression();
      this.semicolon();
      return this.finishNode(node, "ThrowStatement");
    }
    parseCatchClauseParam() {
      const param = this.parseBindingAtom();
      this.scope.enter(this.options.annexB && param.type === "Identifier" ? 8 : 0);
      this.checkLVal(param, {
        type: "CatchClause"
      }, 9);
      return param;
    }
    parseTryStatement(node) {
      this.next();
      node.block = this.parseBlock();
      node.handler = null;
      if (this.match(62)) {
        const clause = this.startNode();
        this.next();
        if (this.match(10)) {
          this.expect(10);
          clause.param = this.parseCatchClauseParam();
          this.expect(11);
        } else {
          clause.param = null;
          this.scope.enter(0);
        }
        clause.body = this.withSmartMixTopicForbiddingContext(() => this.parseBlock(false, false));
        this.scope.exit();
        node.handler = this.finishNode(clause, "CatchClause");
      }
      node.finalizer = this.eat(67) ? this.parseBlock() : null;
      if (!node.handler && !node.finalizer) {
        this.raise(Errors.NoCatchOrFinally, node);
      }
      return this.finishNode(node, "TryStatement");
    }
    parseVarStatement(node, kind, allowMissingInitializer = false) {
      this.next();
      this.parseVar(node, false, kind, allowMissingInitializer);
      this.semicolon();
      return this.finishNode(node, "VariableDeclaration");
    }
    parseWhileStatement(node) {
      this.next();
      node.test = this.parseHeaderExpression();
      this.state.labels.push(loopLabel);
      node.body = this.withSmartMixTopicForbiddingContext(() => this.parseStatement());
      this.state.labels.pop();
      return this.finishNode(node, "WhileStatement");
    }
    parseWithStatement(node) {
      if (this.state.strict) {
        this.raise(Errors.StrictWith, this.state.startLoc);
      }
      this.next();
      node.object = this.parseHeaderExpression();
      node.body = this.withSmartMixTopicForbiddingContext(() => this.parseStatement());
      return this.finishNode(node, "WithStatement");
    }
    parseEmptyStatement(node) {
      this.next();
      return this.finishNode(node, "EmptyStatement");
    }
    parseLabeledStatement(node, maybeName, expr, flags) {
      for (const label of this.state.labels) {
        if (label.name === maybeName) {
          this.raise(Errors.LabelRedeclaration, expr, {
            labelName: maybeName
          });
        }
      }
      const kind = tokenIsLoop(this.state.type) ? 1 : this.match(71) ? 2 : null;
      for (let i = this.state.labels.length - 1;i >= 0; i--) {
        const label = this.state.labels[i];
        if (label.statementStart === node.start) {
          label.statementStart = this.sourceToOffsetPos(this.state.start);
          label.kind = kind;
        } else {
          break;
        }
      }
      this.state.labels.push({
        name: maybeName,
        kind,
        statementStart: this.sourceToOffsetPos(this.state.start)
      });
      node.body = flags & 8 ? this.parseStatementOrSloppyAnnexBFunctionDeclaration(true) : this.parseStatement();
      this.state.labels.pop();
      node.label = expr;
      return this.finishNode(node, "LabeledStatement");
    }
    parseExpressionStatement(node, expr, decorators) {
      node.expression = expr;
      this.semicolon();
      return this.finishNode(node, "ExpressionStatement");
    }
    parseBlock(allowDirectives = false, createNewLexicalScope = true, afterBlockParse) {
      const node = this.startNode();
      if (allowDirectives) {
        this.state.strictErrors.clear();
      }
      this.expect(5);
      if (createNewLexicalScope) {
        this.scope.enter(0);
      }
      this.parseBlockBody(node, allowDirectives, false, 8, afterBlockParse);
      if (createNewLexicalScope) {
        this.scope.exit();
      }
      return this.finishNode(node, "BlockStatement");
    }
    isValidDirective(stmt) {
      return stmt.type === "ExpressionStatement" && stmt.expression.type === "StringLiteral" && !stmt.expression.extra.parenthesized;
    }
    parseBlockBody(node, allowDirectives, topLevel, end, afterBlockParse) {
      const body = node.body = [];
      const directives = node.directives = [];
      this.parseBlockOrModuleBlockBody(body, allowDirectives ? directives : undefined, topLevel, end, afterBlockParse);
    }
    parseBlockOrModuleBlockBody(body, directives, topLevel, end, afterBlockParse) {
      const oldStrict = this.state.strict;
      let hasStrictModeDirective = false;
      let parsedNonDirective = false;
      while (!this.match(end)) {
        const stmt = topLevel ? this.parseModuleItem() : this.parseStatementListItem();
        if (directives && !parsedNonDirective) {
          if (this.isValidDirective(stmt)) {
            const directive = this.stmtToDirective(stmt);
            directives.push(directive);
            if (!hasStrictModeDirective && directive.value.value === "use strict") {
              hasStrictModeDirective = true;
              this.setStrict(true);
            }
            continue;
          }
          parsedNonDirective = true;
          this.state.strictErrors.clear();
        }
        body.push(stmt);
      }
      afterBlockParse == null || afterBlockParse.call(this, hasStrictModeDirective);
      if (!oldStrict) {
        this.setStrict(false);
      }
      this.next();
    }
    parseFor(node, init) {
      node.init = init;
      this.semicolon(false);
      node.test = this.match(13) ? null : this.parseExpression();
      this.semicolon(false);
      node.update = this.match(11) ? null : this.parseExpression();
      this.expect(11);
      node.body = this.withSmartMixTopicForbiddingContext(() => this.parseStatement());
      this.scope.exit();
      this.state.labels.pop();
      return this.finishNode(node, "ForStatement");
    }
    parseForIn(node, init, awaitAt) {
      const isForIn = this.match(58);
      this.next();
      if (isForIn) {
        if (awaitAt !== null)
          this.unexpected(awaitAt);
      } else {
        node.await = awaitAt !== null;
      }
      if (init.type === "VariableDeclaration" && init.declarations[0].init != null && (!isForIn || !this.options.annexB || this.state.strict || init.kind !== "var" || init.declarations[0].id.type !== "Identifier")) {
        this.raise(Errors.ForInOfLoopInitializer, init, {
          type: isForIn ? "ForInStatement" : "ForOfStatement"
        });
      }
      if (init.type === "AssignmentPattern") {
        this.raise(Errors.InvalidLhs, init, {
          ancestor: {
            type: "ForStatement"
          }
        });
      }
      node.left = init;
      node.right = isForIn ? this.parseExpression() : this.parseMaybeAssignAllowIn();
      this.expect(11);
      node.body = this.withSmartMixTopicForbiddingContext(() => this.parseStatement());
      this.scope.exit();
      this.state.labels.pop();
      return this.finishNode(node, isForIn ? "ForInStatement" : "ForOfStatement");
    }
    parseVar(node, isFor, kind, allowMissingInitializer = false) {
      const declarations = node.declarations = [];
      node.kind = kind;
      for (;; ) {
        const decl = this.startNode();
        this.parseVarId(decl, kind);
        decl.init = !this.eat(29) ? null : isFor ? this.parseMaybeAssignDisallowIn() : this.parseMaybeAssignAllowIn();
        if (decl.init === null && !allowMissingInitializer) {
          if (decl.id.type !== "Identifier" && !(isFor && (this.match(58) || this.isContextual(102)))) {
            this.raise(Errors.DeclarationMissingInitializer, this.state.lastTokEndLoc, {
              kind: "destructuring"
            });
          } else if ((kind === "const" || kind === "using" || kind === "await using") && !(this.match(58) || this.isContextual(102))) {
            this.raise(Errors.DeclarationMissingInitializer, this.state.lastTokEndLoc, {
              kind
            });
          }
        }
        declarations.push(this.finishNode(decl, "VariableDeclarator"));
        if (!this.eat(12))
          break;
      }
      return node;
    }
    parseVarId(decl, kind) {
      const id = this.parseBindingAtom();
      if (kind === "using" || kind === "await using") {
        if (id.type === "ArrayPattern" || id.type === "ObjectPattern") {
          this.raise(Errors.UsingDeclarationHasBindingPattern, id.loc.start);
        }
      } else {
        if (id.type === "VoidPattern") {
          this.raise(Errors.UnexpectedVoidPattern, id.loc.start);
        }
      }
      this.checkLVal(id, {
        type: "VariableDeclarator"
      }, kind === "var" ? 5 : 8201);
      decl.id = id;
    }
    parseAsyncFunctionExpression(node) {
      return this.parseFunction(node, 8);
    }
    parseFunction(node, flags = 0) {
      const hangingDeclaration = flags & 2;
      const isDeclaration = !!(flags & 1);
      const requireId = isDeclaration && !(flags & 4);
      const isAsync = !!(flags & 8);
      this.initFunction(node, isAsync);
      if (this.match(55)) {
        if (hangingDeclaration) {
          this.raise(Errors.GeneratorInSingleStatementContext, this.state.startLoc);
        }
        this.next();
        node.generator = true;
      }
      if (isDeclaration) {
        node.id = this.parseFunctionId(requireId);
      }
      const oldMaybeInArrowParameters = this.state.maybeInArrowParameters;
      this.state.maybeInArrowParameters = false;
      this.scope.enter(514);
      this.prodParam.enter(functionFlags(isAsync, node.generator));
      if (!isDeclaration) {
        node.id = this.parseFunctionId();
      }
      this.parseFunctionParams(node, false);
      this.withSmartMixTopicForbiddingContext(() => {
        this.parseFunctionBodyAndFinish(node, isDeclaration ? "FunctionDeclaration" : "FunctionExpression");
      });
      this.prodParam.exit();
      this.scope.exit();
      if (isDeclaration && !hangingDeclaration) {
        this.registerFunctionStatementId(node);
      }
      this.state.maybeInArrowParameters = oldMaybeInArrowParameters;
      return node;
    }
    parseFunctionId(requireId) {
      return requireId || tokenIsIdentifier(this.state.type) ? this.parseIdentifier() : null;
    }
    parseFunctionParams(node, isConstructor) {
      this.expect(10);
      this.expressionScope.enter(newParameterDeclarationScope());
      node.params = this.parseBindingList(11, 41, 2 | (isConstructor ? 4 : 0));
      this.expressionScope.exit();
    }
    registerFunctionStatementId(node) {
      if (!node.id)
        return;
      this.scope.declareName(node.id.name, !this.options.annexB || this.state.strict || node.generator || node.async ? this.scope.treatFunctionsAsVar ? 5 : 8201 : 17, node.id.loc.start);
    }
    parseClass(node, isStatement, optionalId) {
      this.next();
      const oldStrict = this.state.strict;
      this.state.strict = true;
      this.parseClassId(node, isStatement, optionalId);
      this.parseClassSuper(node);
      node.body = this.parseClassBody(!!node.superClass, oldStrict);
      return this.finishNode(node, isStatement ? "ClassDeclaration" : "ClassExpression");
    }
    isClassProperty() {
      return this.match(29) || this.match(13) || this.match(8);
    }
    isClassMethod() {
      return this.match(10);
    }
    nameIsConstructor(key) {
      return key.type === "Identifier" && key.name === "constructor" || key.type === "StringLiteral" && key.value === "constructor";
    }
    isNonstaticConstructor(method) {
      return !method.computed && !method.static && this.nameIsConstructor(method.key);
    }
    parseClassBody(hadSuperClass, oldStrict) {
      this.classScope.enter();
      const state = {
        hadConstructor: false,
        hadSuperClass
      };
      let decorators = [];
      const classBody = this.startNode();
      classBody.body = [];
      this.expect(5);
      this.withSmartMixTopicForbiddingContext(() => {
        while (!this.match(8)) {
          if (this.eat(13)) {
            if (decorators.length > 0) {
              throw this.raise(Errors.DecoratorSemicolon, this.state.lastTokEndLoc);
            }
            continue;
          }
          if (this.match(26)) {
            decorators.push(this.parseDecorator());
            continue;
          }
          const member = this.startNode();
          if (decorators.length) {
            member.decorators = decorators;
            this.resetStartLocationFromNode(member, decorators[0]);
            decorators = [];
          }
          this.parseClassMember(classBody, member, state);
          if (member.kind === "constructor" && member.decorators && member.decorators.length > 0) {
            this.raise(Errors.DecoratorConstructor, member);
          }
        }
      });
      this.state.strict = oldStrict;
      this.next();
      if (decorators.length) {
        throw this.raise(Errors.TrailingDecorator, this.state.startLoc);
      }
      this.classScope.exit();
      return this.finishNode(classBody, "ClassBody");
    }
    parseClassMemberFromModifier(classBody, member) {
      const key = this.parseIdentifier(true);
      if (this.isClassMethod()) {
        const method = member;
        method.kind = "method";
        method.computed = false;
        method.key = key;
        method.static = false;
        this.pushClassMethod(classBody, method, false, false, false, false);
        return true;
      } else if (this.isClassProperty()) {
        const prop = member;
        prop.computed = false;
        prop.key = key;
        prop.static = false;
        classBody.body.push(this.parseClassProperty(prop));
        return true;
      }
      this.resetPreviousNodeTrailingComments(key);
      return false;
    }
    parseClassMember(classBody, member, state) {
      const isStatic = this.isContextual(106);
      if (isStatic) {
        if (this.parseClassMemberFromModifier(classBody, member)) {
          return;
        }
        if (this.eat(5)) {
          this.parseClassStaticBlock(classBody, member);
          return;
        }
      }
      this.parseClassMemberWithIsStatic(classBody, member, state, isStatic);
    }
    parseClassMemberWithIsStatic(classBody, member, state, isStatic) {
      const publicMethod = member;
      const privateMethod = member;
      const publicProp = member;
      const privateProp = member;
      const accessorProp = member;
      const method = publicMethod;
      const publicMember = publicMethod;
      member.static = isStatic;
      this.parsePropertyNamePrefixOperator(member);
      if (this.eat(55)) {
        method.kind = "method";
        const isPrivateName = this.match(139);
        this.parseClassElementName(method);
        this.parsePostMemberNameModifiers(method);
        if (isPrivateName) {
          this.pushClassPrivateMethod(classBody, privateMethod, true, false);
          return;
        }
        if (this.isNonstaticConstructor(publicMethod)) {
          this.raise(Errors.ConstructorIsGenerator, publicMethod.key);
        }
        this.pushClassMethod(classBody, publicMethod, true, false, false, false);
        return;
      }
      const isContextual = !this.state.containsEsc && tokenIsIdentifier(this.state.type);
      const key = this.parseClassElementName(member);
      const maybeContextualKw = isContextual ? key.name : null;
      const isPrivate = this.isPrivateName(key);
      const maybeQuestionTokenStartLoc = this.state.startLoc;
      this.parsePostMemberNameModifiers(publicMember);
      if (this.isClassMethod()) {
        method.kind = "method";
        if (isPrivate) {
          this.pushClassPrivateMethod(classBody, privateMethod, false, false);
          return;
        }
        const isConstructor = this.isNonstaticConstructor(publicMethod);
        let allowsDirectSuper = false;
        if (isConstructor) {
          publicMethod.kind = "constructor";
          if (state.hadConstructor && !this.hasPlugin("typescript")) {
            this.raise(Errors.DuplicateConstructor, key);
          }
          if (isConstructor && this.hasPlugin("typescript") && member.override) {
            this.raise(Errors.OverrideOnConstructor, key);
          }
          state.hadConstructor = true;
          allowsDirectSuper = state.hadSuperClass;
        }
        this.pushClassMethod(classBody, publicMethod, false, false, isConstructor, allowsDirectSuper);
      } else if (this.isClassProperty()) {
        if (isPrivate) {
          this.pushClassPrivateProperty(classBody, privateProp);
        } else {
          this.pushClassProperty(classBody, publicProp);
        }
      } else if (maybeContextualKw === "async" && !this.isLineTerminator()) {
        this.resetPreviousNodeTrailingComments(key);
        const isGenerator = this.eat(55);
        if (publicMember.optional) {
          this.unexpected(maybeQuestionTokenStartLoc);
        }
        method.kind = "method";
        const isPrivate2 = this.match(139);
        this.parseClassElementName(method);
        this.parsePostMemberNameModifiers(publicMember);
        if (isPrivate2) {
          this.pushClassPrivateMethod(classBody, privateMethod, isGenerator, true);
        } else {
          if (this.isNonstaticConstructor(publicMethod)) {
            this.raise(Errors.ConstructorIsAsync, publicMethod.key);
          }
          this.pushClassMethod(classBody, publicMethod, isGenerator, true, false, false);
        }
      } else if ((maybeContextualKw === "get" || maybeContextualKw === "set") && !(this.match(55) && this.isLineTerminator())) {
        this.resetPreviousNodeTrailingComments(key);
        method.kind = maybeContextualKw;
        const isPrivate2 = this.match(139);
        this.parseClassElementName(publicMethod);
        if (isPrivate2) {
          this.pushClassPrivateMethod(classBody, privateMethod, false, false);
        } else {
          if (this.isNonstaticConstructor(publicMethod)) {
            this.raise(Errors.ConstructorIsAccessor, publicMethod.key);
          }
          this.pushClassMethod(classBody, publicMethod, false, false, false, false);
        }
        this.checkGetterSetterParams(publicMethod);
      } else if (maybeContextualKw === "accessor" && !this.isLineTerminator()) {
        this.expectPlugin("decoratorAutoAccessors");
        this.resetPreviousNodeTrailingComments(key);
        const isPrivate2 = this.match(139);
        this.parseClassElementName(publicProp);
        this.pushClassAccessorProperty(classBody, accessorProp, isPrivate2);
      } else if (this.isLineTerminator()) {
        if (isPrivate) {
          this.pushClassPrivateProperty(classBody, privateProp);
        } else {
          this.pushClassProperty(classBody, publicProp);
        }
      } else {
        this.unexpected();
      }
    }
    parseClassElementName(member) {
      const {
        type,
        value
      } = this.state;
      if ((type === 132 || type === 134) && member.static && value === "prototype") {
        this.raise(Errors.StaticPrototype, this.state.startLoc);
      }
      if (type === 139) {
        if (value === "constructor") {
          this.raise(Errors.ConstructorClassPrivateField, this.state.startLoc);
        }
        const key = this.parsePrivateName();
        member.key = key;
        return key;
      }
      this.parsePropertyName(member);
      return member.key;
    }
    parseClassStaticBlock(classBody, member) {
      var _member$decorators;
      this.scope.enter(576 | 128 | 16);
      const oldLabels = this.state.labels;
      this.state.labels = [];
      this.prodParam.enter(0);
      const body = member.body = [];
      this.parseBlockOrModuleBlockBody(body, undefined, false, 8);
      this.prodParam.exit();
      this.scope.exit();
      this.state.labels = oldLabels;
      classBody.body.push(this.finishNode(member, "StaticBlock"));
      if ((_member$decorators = member.decorators) != null && _member$decorators.length) {
        this.raise(Errors.DecoratorStaticBlock, member);
      }
    }
    pushClassProperty(classBody, prop) {
      if (!prop.computed && this.nameIsConstructor(prop.key)) {
        this.raise(Errors.ConstructorClassField, prop.key);
      }
      classBody.body.push(this.parseClassProperty(prop));
    }
    pushClassPrivateProperty(classBody, prop) {
      const node = this.parseClassPrivateProperty(prop);
      classBody.body.push(node);
      this.classScope.declarePrivateName(this.getPrivateNameSV(node.key), 0, node.key.loc.start);
    }
    pushClassAccessorProperty(classBody, prop, isPrivate) {
      if (!isPrivate && !prop.computed && this.nameIsConstructor(prop.key)) {
        this.raise(Errors.ConstructorClassField, prop.key);
      }
      const node = this.parseClassAccessorProperty(prop);
      classBody.body.push(node);
      if (isPrivate) {
        this.classScope.declarePrivateName(this.getPrivateNameSV(node.key), 0, node.key.loc.start);
      }
    }
    pushClassMethod(classBody, method, isGenerator, isAsync, isConstructor, allowsDirectSuper) {
      classBody.body.push(this.parseMethod(method, isGenerator, isAsync, isConstructor, allowsDirectSuper, "ClassMethod", true));
    }
    pushClassPrivateMethod(classBody, method, isGenerator, isAsync) {
      const node = this.parseMethod(method, isGenerator, isAsync, false, false, "ClassPrivateMethod", true);
      classBody.body.push(node);
      const kind = node.kind === "get" ? node.static ? 6 : 2 : node.kind === "set" ? node.static ? 5 : 1 : 0;
      this.declareClassPrivateMethodInScope(node, kind);
    }
    declareClassPrivateMethodInScope(node, kind) {
      this.classScope.declarePrivateName(this.getPrivateNameSV(node.key), kind, node.key.loc.start);
    }
    parsePostMemberNameModifiers(methodOrProp) {}
    parseClassPrivateProperty(node) {
      this.parseInitializer(node);
      this.semicolon();
      return this.finishNode(node, "ClassPrivateProperty");
    }
    parseClassProperty(node) {
      this.parseInitializer(node);
      this.semicolon();
      return this.finishNode(node, "ClassProperty");
    }
    parseClassAccessorProperty(node) {
      this.parseInitializer(node);
      this.semicolon();
      return this.finishNode(node, "ClassAccessorProperty");
    }
    parseInitializer(node) {
      this.scope.enter(576 | 16);
      this.expressionScope.enter(newExpressionScope());
      this.prodParam.enter(0);
      node.value = this.eat(29) ? this.parseMaybeAssignAllowIn() : null;
      this.expressionScope.exit();
      this.prodParam.exit();
      this.scope.exit();
    }
    parseClassId(node, isStatement, optionalId, bindingType = 8331) {
      if (tokenIsIdentifier(this.state.type)) {
        node.id = this.parseIdentifier();
        if (isStatement) {
          this.declareNameFromIdentifier(node.id, bindingType);
        }
      } else {
        if (optionalId || !isStatement) {
          node.id = null;
        } else {
          throw this.raise(Errors.MissingClassName, this.state.startLoc);
        }
      }
    }
    parseClassSuper(node) {
      node.superClass = this.eat(81) ? this.parseExprSubscripts() : null;
    }
    parseExport(node, decorators) {
      const maybeDefaultIdentifier = this.parseMaybeImportPhase(node, true);
      const hasDefault = this.maybeParseExportDefaultSpecifier(node, maybeDefaultIdentifier);
      const parseAfterDefault = !hasDefault || this.eat(12);
      const hasStar = parseAfterDefault && this.eatExportStar(node);
      const hasNamespace = hasStar && this.maybeParseExportNamespaceSpecifier(node);
      const parseAfterNamespace = parseAfterDefault && (!hasNamespace || this.eat(12));
      const isFromRequired = hasDefault || hasStar;
      if (hasStar && !hasNamespace) {
        if (hasDefault)
          this.unexpected();
        if (decorators) {
          throw this.raise(Errors.UnsupportedDecoratorExport, node);
        }
        this.parseExportFrom(node, true);
        this.sawUnambiguousESM = true;
        return this.finishNode(node, "ExportAllDeclaration");
      }
      const hasSpecifiers = this.maybeParseExportNamedSpecifiers(node);
      if (hasDefault && parseAfterDefault && !hasStar && !hasSpecifiers) {
        this.unexpected(null, 5);
      }
      if (hasNamespace && parseAfterNamespace) {
        this.unexpected(null, 98);
      }
      let hasDeclaration;
      if (isFromRequired || hasSpecifiers) {
        hasDeclaration = false;
        if (decorators) {
          throw this.raise(Errors.UnsupportedDecoratorExport, node);
        }
        this.parseExportFrom(node, isFromRequired);
      } else {
        hasDeclaration = this.maybeParseExportDeclaration(node);
      }
      if (isFromRequired || hasSpecifiers || hasDeclaration) {
        var _node2$declaration;
        const node2 = node;
        this.checkExport(node2, true, false, !!node2.source);
        if (((_node2$declaration = node2.declaration) == null ? undefined : _node2$declaration.type) === "ClassDeclaration") {
          this.maybeTakeDecorators(decorators, node2.declaration, node2);
        } else if (decorators) {
          throw this.raise(Errors.UnsupportedDecoratorExport, node);
        }
        this.sawUnambiguousESM = true;
        return this.finishNode(node2, "ExportNamedDeclaration");
      }
      if (this.eat(65)) {
        const node2 = node;
        const decl = this.parseExportDefaultExpression();
        node2.declaration = decl;
        if (decl.type === "ClassDeclaration") {
          this.maybeTakeDecorators(decorators, decl, node2);
        } else if (decorators) {
          throw this.raise(Errors.UnsupportedDecoratorExport, node);
        }
        this.checkExport(node2, true, true);
        this.sawUnambiguousESM = true;
        return this.finishNode(node2, "ExportDefaultDeclaration");
      }
      throw this.unexpected(null, 5);
    }
    eatExportStar(node) {
      return this.eat(55);
    }
    maybeParseExportDefaultSpecifier(node, maybeDefaultIdentifier) {
      if (maybeDefaultIdentifier || this.isExportDefaultSpecifier()) {
        this.expectPlugin("exportDefaultFrom", maybeDefaultIdentifier == null ? undefined : maybeDefaultIdentifier.loc.start);
        const id = maybeDefaultIdentifier || this.parseIdentifier(true);
        const specifier = this.startNodeAtNode(id);
        specifier.exported = id;
        node.specifiers = [this.finishNode(specifier, "ExportDefaultSpecifier")];
        return true;
      }
      return false;
    }
    maybeParseExportNamespaceSpecifier(node) {
      if (this.isContextual(93)) {
        var _ref, _ref$specifiers;
        (_ref$specifiers = (_ref = node).specifiers) != null || (_ref.specifiers = []);
        const specifier = this.startNodeAt(this.state.lastTokStartLoc);
        this.next();
        specifier.exported = this.parseModuleExportName();
        node.specifiers.push(this.finishNode(specifier, "ExportNamespaceSpecifier"));
        return true;
      }
      return false;
    }
    maybeParseExportNamedSpecifiers(node) {
      if (this.match(5)) {
        const node2 = node;
        if (!node2.specifiers)
          node2.specifiers = [];
        const isTypeExport = node2.exportKind === "type";
        node2.specifiers.push(...this.parseExportSpecifiers(isTypeExport));
        node2.source = null;
        if (this.hasPlugin("importAssertions")) {
          node2.assertions = [];
        } else {
          node2.attributes = [];
        }
        node2.declaration = null;
        return true;
      }
      return false;
    }
    maybeParseExportDeclaration(node) {
      if (this.shouldParseExportDeclaration()) {
        node.specifiers = [];
        node.source = null;
        if (this.hasPlugin("importAssertions")) {
          node.assertions = [];
        } else {
          node.attributes = [];
        }
        node.declaration = this.parseExportDeclaration(node);
        return true;
      }
      return false;
    }
    isAsyncFunction() {
      if (!this.isContextual(95))
        return false;
      const next = this.nextTokenInLineStart();
      return this.isUnparsedContextual(next, "function");
    }
    parseExportDefaultExpression() {
      const expr = this.startNode();
      if (this.match(68)) {
        this.next();
        return this.parseFunction(expr, 1 | 4);
      } else if (this.isAsyncFunction()) {
        this.next();
        this.next();
        return this.parseFunction(expr, 1 | 4 | 8);
      }
      if (this.match(80)) {
        return this.parseClass(expr, true, true);
      }
      if (this.match(26)) {
        if (this.hasPlugin("decorators") && this.getPluginOption("decorators", "decoratorsBeforeExport") === true) {
          this.raise(Errors.DecoratorBeforeExport, this.state.startLoc);
        }
        return this.parseClass(this.maybeTakeDecorators(this.parseDecorators(false), this.startNode()), true, true);
      }
      if (this.match(75) || this.match(74) || this.isLet() || this.isUsing() || this.isAwaitUsing()) {
        throw this.raise(Errors.UnsupportedDefaultExport, this.state.startLoc);
      }
      const res = this.parseMaybeAssignAllowIn();
      this.semicolon();
      return res;
    }
    parseExportDeclaration(node) {
      if (this.match(80)) {
        const node2 = this.parseClass(this.startNode(), true, false);
        return node2;
      }
      return this.parseStatementListItem();
    }
    isExportDefaultSpecifier() {
      const {
        type
      } = this.state;
      if (tokenIsIdentifier(type)) {
        if (type === 95 && !this.state.containsEsc || type === 100) {
          return false;
        }
        if ((type === 130 || type === 129) && !this.state.containsEsc) {
          const next2 = this.nextTokenStart();
          const nextChar = this.input.charCodeAt(next2);
          if (nextChar === 123 || this.chStartsBindingIdentifier(nextChar, next2) && !this.input.startsWith("from", next2)) {
            this.expectOnePlugin(["flow", "typescript"]);
            return false;
          }
        }
      } else if (!this.match(65)) {
        return false;
      }
      const next = this.nextTokenStart();
      const hasFrom = this.isUnparsedContextual(next, "from");
      if (this.input.charCodeAt(next) === 44 || tokenIsIdentifier(this.state.type) && hasFrom) {
        return true;
      }
      if (this.match(65) && hasFrom) {
        const nextAfterFrom = this.input.charCodeAt(this.nextTokenStartSince(next + 4));
        return nextAfterFrom === 34 || nextAfterFrom === 39;
      }
      return false;
    }
    parseExportFrom(node, expect) {
      if (this.eatContextual(98)) {
        node.source = this.parseImportSource();
        this.checkExport(node);
        this.maybeParseImportAttributes(node);
        this.checkJSONModuleImport(node);
      } else if (expect) {
        this.unexpected();
      }
      this.semicolon();
    }
    shouldParseExportDeclaration() {
      const {
        type
      } = this.state;
      if (type === 26) {
        this.expectOnePlugin(["decorators", "decorators-legacy"]);
        if (this.hasPlugin("decorators")) {
          if (this.getPluginOption("decorators", "decoratorsBeforeExport") === true) {
            this.raise(Errors.DecoratorBeforeExport, this.state.startLoc);
          }
          return true;
        }
      }
      if (this.isUsing()) {
        this.raise(Errors.UsingDeclarationExport, this.state.startLoc);
        return true;
      }
      if (this.isAwaitUsing()) {
        this.raise(Errors.UsingDeclarationExport, this.state.startLoc);
        return true;
      }
      return type === 74 || type === 75 || type === 68 || type === 80 || this.isLet() || this.isAsyncFunction();
    }
    checkExport(node, checkNames, isDefault, isFrom) {
      if (checkNames) {
        var _node$specifiers;
        if (isDefault) {
          this.checkDuplicateExports(node, "default");
          if (this.hasPlugin("exportDefaultFrom")) {
            var _declaration$extra;
            const declaration = node.declaration;
            if (declaration.type === "Identifier" && declaration.name === "from" && declaration.end - declaration.start === 4 && !((_declaration$extra = declaration.extra) != null && _declaration$extra.parenthesized)) {
              this.raise(Errors.ExportDefaultFromAsIdentifier, declaration);
            }
          }
        } else if ((_node$specifiers = node.specifiers) != null && _node$specifiers.length) {
          for (const specifier of node.specifiers) {
            const {
              exported
            } = specifier;
            const exportName = exported.type === "Identifier" ? exported.name : exported.value;
            this.checkDuplicateExports(specifier, exportName);
            if (!isFrom && specifier.local) {
              const {
                local
              } = specifier;
              if (local.type !== "Identifier") {
                this.raise(Errors.ExportBindingIsString, specifier, {
                  localName: local.value,
                  exportName
                });
              } else {
                this.checkReservedWord(local.name, local.loc.start, true, false);
                this.scope.checkLocalExport(local);
              }
            }
          }
        } else if (node.declaration) {
          const decl = node.declaration;
          if (decl.type === "FunctionDeclaration" || decl.type === "ClassDeclaration") {
            const {
              id
            } = decl;
            if (!id)
              throw new Error("Assertion failure");
            this.checkDuplicateExports(node, id.name);
          } else if (decl.type === "VariableDeclaration") {
            for (const declaration of decl.declarations) {
              this.checkDeclaration(declaration.id);
            }
          }
        }
      }
    }
    checkDeclaration(node) {
      if (node.type === "Identifier") {
        this.checkDuplicateExports(node, node.name);
      } else if (node.type === "ObjectPattern") {
        for (const prop of node.properties) {
          this.checkDeclaration(prop);
        }
      } else if (node.type === "ArrayPattern") {
        for (const elem of node.elements) {
          if (elem) {
            this.checkDeclaration(elem);
          }
        }
      } else if (node.type === "ObjectProperty") {
        this.checkDeclaration(node.value);
      } else if (node.type === "RestElement") {
        this.checkDeclaration(node.argument);
      } else if (node.type === "AssignmentPattern") {
        this.checkDeclaration(node.left);
      }
    }
    checkDuplicateExports(node, exportName) {
      if (this.exportedIdentifiers.has(exportName)) {
        if (exportName === "default") {
          this.raise(Errors.DuplicateDefaultExport, node);
        } else {
          this.raise(Errors.DuplicateExport, node, {
            exportName
          });
        }
      }
      this.exportedIdentifiers.add(exportName);
    }
    parseExportSpecifiers(isInTypeExport) {
      const nodes = [];
      let first = true;
      this.expect(5);
      while (!this.eat(8)) {
        if (first) {
          first = false;
        } else {
          this.expect(12);
          if (this.eat(8))
            break;
        }
        const isMaybeTypeOnly = this.isContextual(130);
        const isString = this.match(134);
        const node = this.startNode();
        node.local = this.parseModuleExportName();
        nodes.push(this.parseExportSpecifier(node, isString, isInTypeExport, isMaybeTypeOnly));
      }
      return nodes;
    }
    parseExportSpecifier(node, isString, isInTypeExport, isMaybeTypeOnly) {
      if (this.eatContextual(93)) {
        node.exported = this.parseModuleExportName();
      } else if (isString) {
        node.exported = this.cloneStringLiteral(node.local);
      } else if (!node.exported) {
        node.exported = this.cloneIdentifier(node.local);
      }
      return this.finishNode(node, "ExportSpecifier");
    }
    parseModuleExportName() {
      if (this.match(134)) {
        const result = this.parseStringLiteral(this.state.value);
        const surrogate = loneSurrogate.exec(result.value);
        if (surrogate) {
          this.raise(Errors.ModuleExportNameHasLoneSurrogate, result, {
            surrogateCharCode: surrogate[0].charCodeAt(0)
          });
        }
        return result;
      }
      return this.parseIdentifier(true);
    }
    isJSONModuleImport(node) {
      if (node.assertions != null) {
        return node.assertions.some(({
          key,
          value
        }) => {
          return value.value === "json" && (key.type === "Identifier" ? key.name === "type" : key.value === "type");
        });
      }
      return false;
    }
    checkImportReflection(node) {
      const {
        specifiers
      } = node;
      const singleBindingType = specifiers.length === 1 ? specifiers[0].type : null;
      if (node.phase === "source") {
        if (singleBindingType !== "ImportDefaultSpecifier") {
          this.raise(Errors.SourcePhaseImportRequiresDefault, specifiers[0].loc.start);
        }
      } else if (node.phase === "defer") {
        if (singleBindingType !== "ImportNamespaceSpecifier") {
          this.raise(Errors.DeferImportRequiresNamespace, specifiers[0].loc.start);
        }
      } else if (node.module) {
        var _node$assertions;
        if (singleBindingType !== "ImportDefaultSpecifier") {
          this.raise(Errors.ImportReflectionNotBinding, specifiers[0].loc.start);
        }
        if (((_node$assertions = node.assertions) == null ? undefined : _node$assertions.length) > 0) {
          this.raise(Errors.ImportReflectionHasAssertion, specifiers[0].loc.start);
        }
      }
    }
    checkJSONModuleImport(node) {
      if (this.isJSONModuleImport(node) && node.type !== "ExportAllDeclaration") {
        const {
          specifiers
        } = node;
        if (specifiers != null) {
          const nonDefaultNamedSpecifier = specifiers.find((specifier) => {
            let imported;
            if (specifier.type === "ExportSpecifier") {
              imported = specifier.local;
            } else if (specifier.type === "ImportSpecifier") {
              imported = specifier.imported;
            }
            if (imported !== undefined) {
              return imported.type === "Identifier" ? imported.name !== "default" : imported.value !== "default";
            }
          });
          if (nonDefaultNamedSpecifier !== undefined) {
            this.raise(Errors.ImportJSONBindingNotDefault, nonDefaultNamedSpecifier.loc.start);
          }
        }
      }
    }
    isPotentialImportPhase(isExport) {
      if (isExport)
        return false;
      return this.isContextual(105) || this.isContextual(97) || this.isContextual(127);
    }
    applyImportPhase(node, isExport, phase, loc) {
      if (isExport) {
        return;
      }
      if (phase === "module") {
        this.expectPlugin("importReflection", loc);
        node.module = true;
      } else if (this.hasPlugin("importReflection")) {
        node.module = false;
      }
      if (phase === "source") {
        this.expectPlugin("sourcePhaseImports", loc);
        node.phase = "source";
      } else if (phase === "defer") {
        this.expectPlugin("deferredImportEvaluation", loc);
        node.phase = "defer";
      } else if (this.hasPlugin("sourcePhaseImports")) {
        node.phase = null;
      }
    }
    parseMaybeImportPhase(node, isExport) {
      if (!this.isPotentialImportPhase(isExport)) {
        this.applyImportPhase(node, isExport, null);
        return null;
      }
      const phaseIdentifier = this.startNode();
      const phaseIdentifierName = this.parseIdentifierName(true);
      const {
        type
      } = this.state;
      const isImportPhase = tokenIsKeywordOrIdentifier(type) ? type !== 98 || this.lookaheadCharCode() === 102 : type !== 12;
      if (isImportPhase) {
        this.applyImportPhase(node, isExport, phaseIdentifierName, phaseIdentifier.loc.start);
        return null;
      } else {
        this.applyImportPhase(node, isExport, null);
        return this.createIdentifier(phaseIdentifier, phaseIdentifierName);
      }
    }
    isPrecedingIdImportPhase(phase) {
      const {
        type
      } = this.state;
      return tokenIsIdentifier(type) ? type !== 98 || this.lookaheadCharCode() === 102 : type !== 12;
    }
    parseImport(node) {
      if (this.match(134)) {
        return this.parseImportSourceAndAttributes(node);
      }
      return this.parseImportSpecifiersAndAfter(node, this.parseMaybeImportPhase(node, false));
    }
    parseImportSpecifiersAndAfter(node, maybeDefaultIdentifier) {
      node.specifiers = [];
      const hasDefault = this.maybeParseDefaultImportSpecifier(node, maybeDefaultIdentifier);
      const parseNext = !hasDefault || this.eat(12);
      const hasStar = parseNext && this.maybeParseStarImportSpecifier(node);
      if (parseNext && !hasStar)
        this.parseNamedImportSpecifiers(node);
      this.expectContextual(98);
      return this.parseImportSourceAndAttributes(node);
    }
    parseImportSourceAndAttributes(node) {
      var _node$specifiers2;
      (_node$specifiers2 = node.specifiers) != null || (node.specifiers = []);
      node.source = this.parseImportSource();
      this.maybeParseImportAttributes(node);
      this.checkImportReflection(node);
      this.checkJSONModuleImport(node);
      this.semicolon();
      this.sawUnambiguousESM = true;
      return this.finishNode(node, "ImportDeclaration");
    }
    parseImportSource() {
      if (!this.match(134))
        this.unexpected();
      return this.parseExprAtom();
    }
    parseImportSpecifierLocal(node, specifier, type) {
      specifier.local = this.parseIdentifier();
      node.specifiers.push(this.finishImportSpecifier(specifier, type));
    }
    finishImportSpecifier(specifier, type, bindingType = 8201) {
      this.checkLVal(specifier.local, {
        type
      }, bindingType);
      return this.finishNode(specifier, type);
    }
    parseImportAttributes() {
      this.expect(5);
      const attrs = [];
      const attrNames = new Set;
      do {
        if (this.match(8)) {
          break;
        }
        const node = this.startNode();
        const keyName = this.state.value;
        if (attrNames.has(keyName)) {
          this.raise(Errors.ModuleAttributesWithDuplicateKeys, this.state.startLoc, {
            key: keyName
          });
        }
        attrNames.add(keyName);
        if (this.match(134)) {
          node.key = this.parseStringLiteral(keyName);
        } else {
          node.key = this.parseIdentifier(true);
        }
        this.expect(14);
        if (!this.match(134)) {
          throw this.raise(Errors.ModuleAttributeInvalidValue, this.state.startLoc);
        }
        node.value = this.parseStringLiteral(this.state.value);
        attrs.push(this.finishNode(node, "ImportAttribute"));
      } while (this.eat(12));
      this.expect(8);
      return attrs;
    }
    parseModuleAttributes() {
      const attrs = [];
      const attributes = new Set;
      do {
        const node = this.startNode();
        node.key = this.parseIdentifier(true);
        if (node.key.name !== "type") {
          this.raise(Errors.ModuleAttributeDifferentFromType, node.key);
        }
        if (attributes.has(node.key.name)) {
          this.raise(Errors.ModuleAttributesWithDuplicateKeys, node.key, {
            key: node.key.name
          });
        }
        attributes.add(node.key.name);
        this.expect(14);
        if (!this.match(134)) {
          throw this.raise(Errors.ModuleAttributeInvalidValue, this.state.startLoc);
        }
        node.value = this.parseStringLiteral(this.state.value);
        attrs.push(this.finishNode(node, "ImportAttribute"));
      } while (this.eat(12));
      return attrs;
    }
    maybeParseImportAttributes(node) {
      let attributes;
      var useWith = false;
      if (this.match(76)) {
        if (this.hasPrecedingLineBreak() && this.lookaheadCharCode() === 40) {
          return;
        }
        this.next();
        if (this.hasPlugin("moduleAttributes")) {
          attributes = this.parseModuleAttributes();
          this.addExtra(node, "deprecatedWithLegacySyntax", true);
        } else {
          attributes = this.parseImportAttributes();
        }
        useWith = true;
      } else if (this.isContextual(94) && !this.hasPrecedingLineBreak()) {
        if (!this.hasPlugin("deprecatedImportAssert") && !this.hasPlugin("importAssertions")) {
          this.raise(Errors.ImportAttributesUseAssert, this.state.startLoc);
        }
        if (!this.hasPlugin("importAssertions")) {
          this.addExtra(node, "deprecatedAssertSyntax", true);
        }
        this.next();
        attributes = this.parseImportAttributes();
      } else {
        attributes = [];
      }
      if (!useWith && this.hasPlugin("importAssertions")) {
        node.assertions = attributes;
      } else {
        node.attributes = attributes;
      }
    }
    maybeParseDefaultImportSpecifier(node, maybeDefaultIdentifier) {
      if (maybeDefaultIdentifier) {
        const specifier = this.startNodeAtNode(maybeDefaultIdentifier);
        specifier.local = maybeDefaultIdentifier;
        node.specifiers.push(this.finishImportSpecifier(specifier, "ImportDefaultSpecifier"));
        return true;
      } else if (tokenIsKeywordOrIdentifier(this.state.type)) {
        this.parseImportSpecifierLocal(node, this.startNode(), "ImportDefaultSpecifier");
        return true;
      }
      return false;
    }
    maybeParseStarImportSpecifier(node) {
      if (this.match(55)) {
        const specifier = this.startNode();
        this.next();
        this.expectContextual(93);
        this.parseImportSpecifierLocal(node, specifier, "ImportNamespaceSpecifier");
        return true;
      }
      return false;
    }
    parseNamedImportSpecifiers(node) {
      let first = true;
      this.expect(5);
      while (!this.eat(8)) {
        if (first) {
          first = false;
        } else {
          if (this.eat(14)) {
            throw this.raise(Errors.DestructureNamedImport, this.state.startLoc);
          }
          this.expect(12);
          if (this.eat(8))
            break;
        }
        const specifier = this.startNode();
        const importedIsString = this.match(134);
        const isMaybeTypeOnly = this.isContextual(130);
        specifier.imported = this.parseModuleExportName();
        const importSpecifier = this.parseImportSpecifier(specifier, importedIsString, node.importKind === "type" || node.importKind === "typeof", isMaybeTypeOnly, undefined);
        node.specifiers.push(importSpecifier);
      }
    }
    parseImportSpecifier(specifier, importedIsString, isInTypeOnlyImport, isMaybeTypeOnly, bindingType) {
      if (this.eatContextual(93)) {
        specifier.local = this.parseIdentifier();
      } else {
        const {
          imported
        } = specifier;
        if (importedIsString) {
          throw this.raise(Errors.ImportBindingIsString, specifier, {
            importName: imported.value
          });
        }
        this.checkReservedWord(imported.name, specifier.loc.start, true, true);
        if (!specifier.local) {
          specifier.local = this.cloneIdentifier(imported);
        }
      }
      return this.finishImportSpecifier(specifier, "ImportSpecifier", bindingType);
    }
    isThisParam(param) {
      return param.type === "Identifier" && param.name === "this";
    }
  }

  class Parser extends StatementParser {
    constructor(options, input, pluginsMap) {
      const normalizedOptions = getOptions(options);
      super(normalizedOptions, input);
      this.options = normalizedOptions;
      this.initializeScopes();
      this.plugins = pluginsMap;
      this.filename = normalizedOptions.sourceFilename;
      this.startIndex = normalizedOptions.startIndex;
      let optionFlags = 0;
      if (normalizedOptions.allowAwaitOutsideFunction) {
        optionFlags |= 1;
      }
      if (normalizedOptions.allowReturnOutsideFunction) {
        optionFlags |= 2;
      }
      if (normalizedOptions.allowImportExportEverywhere) {
        optionFlags |= 8;
      }
      if (normalizedOptions.allowSuperOutsideMethod) {
        optionFlags |= 16;
      }
      if (normalizedOptions.allowUndeclaredExports) {
        optionFlags |= 64;
      }
      if (normalizedOptions.allowNewTargetOutsideFunction) {
        optionFlags |= 4;
      }
      if (normalizedOptions.allowYieldOutsideFunction) {
        optionFlags |= 32;
      }
      if (normalizedOptions.ranges) {
        optionFlags |= 128;
      }
      if (normalizedOptions.tokens) {
        optionFlags |= 256;
      }
      if (normalizedOptions.createImportExpressions) {
        optionFlags |= 512;
      }
      if (normalizedOptions.createParenthesizedExpressions) {
        optionFlags |= 1024;
      }
      if (normalizedOptions.errorRecovery) {
        optionFlags |= 2048;
      }
      if (normalizedOptions.attachComment) {
        optionFlags |= 4096;
      }
      if (normalizedOptions.annexB) {
        optionFlags |= 8192;
      }
      this.optionFlags = optionFlags;
    }
    getScopeHandler() {
      return ScopeHandler;
    }
    parse() {
      this.enterInitialScopes();
      const file = this.startNode();
      const program = this.startNode();
      this.nextToken();
      file.errors = null;
      const result = this.parseTopLevel(file, program);
      result.errors = this.state.errors;
      result.comments.length = this.state.commentsLen;
      return result;
    }
  }
  function parse(input, options) {
    var _options;
    if (((_options = options) == null ? undefined : _options.sourceType) === "unambiguous") {
      options = Object.assign({}, options);
      try {
        options.sourceType = "module";
        const parser = getParser(options, input);
        const ast = parser.parse();
        if (parser.sawUnambiguousESM) {
          return ast;
        }
        if (parser.ambiguousScriptDifferentAst) {
          try {
            options.sourceType = "script";
            return getParser(options, input).parse();
          } catch (_unused) {}
        } else {
          ast.program.sourceType = "script";
        }
        return ast;
      } catch (moduleError) {
        try {
          options.sourceType = "script";
          return getParser(options, input).parse();
        } catch (_unused2) {}
        throw moduleError;
      }
    } else {
      return getParser(options, input).parse();
    }
  }
  function parseExpression(input, options) {
    const parser = getParser(options, input);
    if (parser.options.strictMode) {
      parser.state.strict = true;
    }
    return parser.getExpression();
  }
  function generateExportedTokenTypes(internalTokenTypes) {
    const tokenTypes2 = {};
    for (const typeName of Object.keys(internalTokenTypes)) {
      tokenTypes2[typeName] = getExportedToken(internalTokenTypes[typeName]);
    }
    return tokenTypes2;
  }
  var tokTypes = generateExportedTokenTypes(tt);
  function getParser(options, input) {
    let cls = Parser;
    const pluginsMap = new Map;
    if (options != null && options.plugins) {
      for (const plugin of options.plugins) {
        let name, opts;
        if (typeof plugin === "string") {
          name = plugin;
        } else {
          [name, opts] = plugin;
        }
        if (!pluginsMap.has(name)) {
          pluginsMap.set(name, opts || {});
        }
      }
      validatePlugins(pluginsMap);
      cls = getParserClass(pluginsMap);
    }
    return new cls(options, input, pluginsMap);
  }
  var parserClassCache = new Map;
  function getParserClass(pluginsMap) {
    const pluginList = [];
    for (const name of mixinPluginNames) {
      if (pluginsMap.has(name)) {
        pluginList.push(name);
      }
    }
    const key = pluginList.join("|");
    let cls = parserClassCache.get(key);
    if (!cls) {
      cls = Parser;
      for (const plugin of pluginList) {
        cls = mixinPlugins[plugin](cls);
      }
      parserClassCache.set(key, cls);
    }
    return cls;
  }
  exports.parse = parse;
  exports.parseExpression = parseExpression;
  exports.tokTypes = tokTypes;
});

// src/eval/js/shared/rewrite-imports.ts
async function loadBabelParser() {
  if (!babelParser) {
    babelParser = await Promise.resolve().then(() => __toESM(require_lib(), 1));
  }
  return babelParser;
}
async function parseProgram(code) {
  const { parse } = await loadBabelParser();
  try {
    return parse(code, {
      sourceType: "module",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      allowImportExportEverywhere: true,
      allowNewTargetOutsideFunction: true,
      allowSuperOutsideMethod: true,
      allowUndeclaredExports: true,
      errorRecovery: true,
      plugins: ["typescript"]
    });
  } catch {
    return null;
  }
}
function buildOmpImportCall(sourceLiteral, optionsLiteral) {
  return optionsLiteral ? `__omp_import__(${sourceLiteral}, ${optionsLiteral})` : `__omp_import__(${sourceLiteral})`;
}
function walkNodes(root, visit) {
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object")
      continue;
    if (Array.isArray(current)) {
      for (let i = current.length - 1;i >= 0; i--)
        stack.push(current[i]);
      continue;
    }
    const node = current;
    if (typeof node.type === "string")
      visit(node);
    for (const key in node) {
      if (key === "loc" || key === "extra" || key === "range")
        continue;
      if (key === "leadingComments" || key === "trailingComments" || key === "innerComments")
        continue;
      const value = node[key];
      if (value && typeof value === "object")
        stack.push(value);
    }
  }
}
function buildOptionsLiteral(node) {
  const attrs = node.attributes;
  if (!attrs || attrs.length === 0)
    return;
  const pairs = attrs.map((attr) => {
    const key = attr.key.type === "Identifier" ? attr.key.name : JSON.stringify(attr.key.value);
    return `${key}: ${JSON.stringify(attr.value.value)}`;
  });
  return `{ with: { ${pairs.join(", ")} } }`;
}
function rewriteImportNode(node) {
  const sourceLiteral = JSON.stringify(node.source.value);
  const optionsLiteral = buildOptionsLiteral(node);
  const importCall = buildOmpImportCall(sourceLiteral, optionsLiteral);
  let defaultName;
  let namespaceName;
  const namedPairs = [];
  for (const spec of node.specifiers) {
    if (spec.type === "ImportDefaultSpecifier") {
      defaultName = spec.local.name;
    } else if (spec.type === "ImportNamespaceSpecifier") {
      namespaceName = spec.local.name;
    } else if (spec.type === "ImportSpecifier" && spec.imported) {
      const imported = spec.imported.type === "Identifier" ? spec.imported.name : spec.imported.value;
      namedPairs.push([imported, spec.local.name]);
    }
  }
  if (namedPairs.length > 0) {
    const inner = namedPairs.map(([imp, loc]) => imp === loc ? imp : `${imp}: ${loc}`).join(", ");
    const props = defaultName ? `default: ${defaultName}, ${inner}` : inner;
    return `const { ${props} } = await ${importCall};`;
  }
  if (namespaceName && defaultName) {
    return `const ${namespaceName} = await ${importCall}; const ${defaultName} = ${namespaceName}.default;`;
  }
  if (namespaceName)
    return `const ${namespaceName} = await ${importCall};`;
  if (defaultName)
    return `const ${defaultName} = (await ${importCall}).default;`;
  return `await ${importCall};`;
}
async function rewriteImports(code) {
  if (!code.includes("import"))
    return code;
  const ast = await parseProgram(code);
  if (!ast) {
    return code;
  }
  const edits = [];
  for (const node of ast.program.body) {
    if (node.type !== "ImportDeclaration")
      continue;
    const decl = node;
    edits.push({ start: decl.start, end: decl.end, text: rewriteImportNode(decl) });
  }
  walkNodes(ast, (node) => {
    if (node.type !== "CallExpression")
      return;
    const call = node;
    const callee = call.callee;
    if (callee?.type !== "Import" || typeof callee.start !== "number" || typeof callee.end !== "number")
      return;
    edits.push({ start: callee.start, end: callee.end, text: DYNAMIC_IMPORT_CALLEE });
  });
  if (edits.length === 0)
    return code;
  edits.sort((a, b) => b.start - a.start);
  let result = code;
  for (const edit of edits) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}
async function collectModuleSourceSpecifiers(code) {
  const ast = await parseProgram(code);
  if (!ast)
    return [];
  const sources = [];
  for (const node of ast.program.body) {
    if ((node.type === "ImportDeclaration" || node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") && typeof node.source?.value === "string") {
      sources.push(node.source.value);
    }
  }
  return sources;
}
function collectBindingNames(pattern, names) {
  if (!pattern || typeof pattern !== "object")
    return;
  const node = pattern;
  switch (node.type) {
    case "Identifier":
      if (typeof node.name === "string")
        names.push(node.name);
      return;
    case "ObjectPattern":
      for (const property of node.properties ?? [])
        collectBindingNames(property, names);
      return;
    case "ObjectProperty":
    case "Property":
      collectBindingNames(node.value, names);
      return;
    case "ArrayPattern":
      for (const element of node.elements ?? [])
        collectBindingNames(element, names);
      return;
    case "AssignmentPattern":
      collectBindingNames(node.left, names);
      return;
    case "RestElement":
      collectBindingNames(node.argument, names);
      return;
    case "TSParameterProperty":
      collectBindingNames(node.parameter, names);
      return;
    default:
      return;
  }
}
function getLexicalBindingNames(node) {
  const names = [];
  if (node.type === "VariableDeclaration") {
    for (const declaration of node.declarations ?? [])
      collectBindingNames(declaration.id, names);
  } else if (node.id) {
    names.push(node.id.name);
  }
  return names;
}
function appendGlobalBindingPublish(source, names) {
  if (names.length === 0)
    return source;
  const assignments = names.map((name) => `this[${JSON.stringify(name)}] = ${name};`).join(`
`);
  return `${source};
${assignments}`;
}
async function demoteTopLevelLexicals(code, options = {}) {
  const publishGlobals = options.publishGlobals === true;
  const fastPath = publishGlobals ? /\b(?:const|let|class|var|function)\b/ : /\b(?:const|let|class)\b/;
  if (!fastPath.test(code))
    return code;
  const ast = await parseProgram(code);
  if (!ast) {
    return code;
  }
  const targets = [];
  for (const node of ast.program.body) {
    if (node.type === "VariableDeclaration") {
      const decl = node;
      if (decl.kind === "const" || decl.kind === "let")
        targets.push({ node: decl, demote: true });
      else if (publishGlobals)
        targets.push({ node: decl, demote: false });
    } else if (node.type === "ClassDeclaration") {
      const decl = node;
      if (decl.id)
        targets.push({ node: decl, demote: true });
    } else if (publishGlobals && node.type === "FunctionDeclaration") {
      const decl = node;
      if (decl.id)
        targets.push({ node: decl, demote: false });
    }
  }
  if (targets.length === 0)
    return code;
  targets.sort((a, b) => b.node.start - a.node.start);
  let result = code;
  for (const { node, demote } of targets) {
    const segment = result.slice(node.start, node.end);
    const bindingNames = publishGlobals ? getLexicalBindingNames(node) : [];
    let replacement;
    if (!demote) {
      replacement = segment;
    } else if (node.type === "VariableDeclaration") {
      replacement = `var${segment.slice(node.kind.length)}`;
    } else {
      const id = node.id;
      if (!id)
        continue;
      const idEndInSegment = id.end - node.start;
      const tail = segment.slice(idEndInSegment);
      const hasTrailingSemi = segment.endsWith(";");
      replacement = `var ${id.name} = class${tail}${hasTrailingSemi ? "" : ";"}`;
    }
    result = result.slice(0, node.start) + appendGlobalBindingPublish(replacement, bindingNames) + result.slice(node.end);
  }
  return result;
}
async function returnFinalExpression(code) {
  const ast = await parseProgram(code);
  const body = ast?.program.body;
  if (!body)
    return { source: code, returned: false };
  let lastIndex = body.length - 1;
  while (lastIndex >= 0 && body[lastIndex]?.type === "EmptyStatement")
    lastIndex--;
  const last = lastIndex >= 0 ? body[lastIndex] : undefined;
  if (last?.type === "ExpressionStatement") {
    const expression = last;
    const prefix = code.slice(0, expression.start);
    const statement = code.slice(expression.start, expression.end);
    const suffix = code.slice(expression.end);
    const semicolonMatch = statement.match(/;\s*$/);
    const trimmedStatement = semicolonMatch ? statement.slice(0, semicolonMatch.index) : statement;
    return { source: `${prefix}__omp_set_final_expr__((${trimmedStatement}));${suffix}`, returned: true };
  }
  if (last?.type === "ReturnStatement") {
    const ret = last;
    if (!ret.argument)
      return { source: code, returned: false };
    const prefix = code.slice(0, ret.start);
    const suffix = code.slice(ret.end);
    const expr = code.slice(ret.argument.start, ret.argument.end);
    return { source: `${prefix}__omp_set_final_expr__((${expr}));${suffix}`, returned: true };
  }
  return { source: code, returned: false };
}
function isExecutionBoundary(type) {
  return type === "FunctionDeclaration" || type === "FunctionExpression" || type === "ArrowFunctionExpression" || type === "ObjectMethod" || type === "ClassMethod" || type === "ClassPrivateMethod" || type === "PrivateMethod";
}
function containsAsyncWrapperSyntax(value) {
  if (!value || typeof value !== "object")
    return false;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (containsAsyncWrapperSyntax(item))
        return true;
    }
    return false;
  }
  const node = value;
  const type = node.type;
  if (type === "ReturnStatement" || type === "AwaitExpression")
    return true;
  if (type === "ForOfStatement" && node.await === true)
    return true;
  if (typeof type === "string" && isExecutionBoundary(type))
    return false;
  for (const key in node) {
    if (key === "loc" || key === "extra" || key === "range")
      continue;
    if (key === "leadingComments" || key === "trailingComments" || key === "innerComments")
      continue;
    if (containsAsyncWrapperSyntax(node[key]))
      return true;
  }
  return false;
}
async function requiresAsyncWrapper(code) {
  const ast = await parseProgram(code);
  if (!ast)
    return false;
  for (const node of ast.program.body) {
    if (containsAsyncWrapperSyntax(node))
      return true;
  }
  return false;
}
function stripTypeScript(code, options = {}) {
  if (!options.force && !LOOKS_LIKE_TS.test(code))
    return code;
  try {
    const transpiler = options.loader === "tsx" ? TSX_TRANSPILER : TS_TRANSPILER;
    return transpiler.transformSync(code);
  } catch {
    return code;
  }
}
function stripTypeScriptSyntax(code, options = {}) {
  return stripTypeScript(code, options);
}
async function wrapCode(code) {
  const finalExpression = await returnFinalExpression(code);
  const stripped = stripTypeScript(finalExpression.source);
  const importsRewritten = await rewriteImports(stripped);
  const needsAsyncWrapper = await requiresAsyncWrapper(importsRewritten);
  const rewritten = {
    source: await demoteTopLevelLexicals(importsRewritten, { publishGlobals: needsAsyncWrapper }),
    returned: finalExpression.returned
  };
  if (!needsAsyncWrapper) {
    return { source: rewritten.source, asyncWrapped: false, finalExpressionReturned: rewritten.returned };
  }
  return {
    source: `(async () => {
${rewritten.source}
})()`,
    asyncWrapped: true,
    finalExpressionReturned: rewritten.returned
  };
}
var babelParser, DYNAMIC_IMPORT_CALLEE = '(typeof __omp_import__ === "function" ? __omp_import__ : (s, o) => import(s, o))', TS_TRANSPILER, TSX_TRANSPILER, LOOKS_LIKE_TS;
var init_rewrite_imports = __esm(() => {
  TS_TRANSPILER = new Bun.Transpiler({ loader: "ts" });
  TSX_TRANSPILER = new Bun.Transpiler({ loader: "tsx" });
  LOOKS_LIKE_TS = /(?:\bimport\s+type\b|\bexport\s+type\b|\b(?:import|export)\s*\{[^}\n]*\btype\s+\w|\binterface\s+\w|\btype\s+\w+\s*=|\b(?:as|satisfies)\s+(?:[A-Z]|\bconst\b)|:\s*(?:string|number|boolean|any|unknown|void|never|object|[A-Z]\w*)\b|<\s*[A-Z]\w*\s*[,>])/;
});

// src/eval/js/shared/local-module-loader.ts
import * as fs5 from "fs";
import { createRequire } from "module";
import * as path4 from "path";
import { fileURLToPath, pathToFileURL } from "url";
import * as vm from "vm";

class LocalModuleLoader {
  #context;
  #sessionTag;
  #moduleMtimes = new Map;
  #moduleDeps = new Map;
  #moduleParents = new Map;
  #moduleVersions = new Map;
  #moduleEntries = new Map;
  #moduleBuilds = new Map;
  #externalModules = new Map;
  #requireCache = new Map;
  #modulePaths = new WeakMap;
  #linkChain = Promise.resolve();
  constructor(sessionId) {
    this.#context = vm.createContext(globalThis);
    this.#sessionTag = Bun.hash(sessionId).toString(16);
  }
  async resolveForRun(cwd, source) {
    this.#refreshTrackedLocalModules();
    return await this.#resolveFromBase(cwd, source);
  }
  async resolveForModule(moduleUrl, source, cwd) {
    this.#refreshTrackedLocalModules();
    const modulePath = this.filenameForUrl(moduleUrl);
    const baseDir = modulePath ? path4.dirname(modulePath) : cwd;
    return await this.#resolveFromBase(baseDir, source);
  }
  requireForFile(moduleUrlOrPath, cwd) {
    const basePath = this.filenameForUrl(moduleUrlOrPath) ?? path4.join(cwd, "[eval]");
    let cached = this.#requireCache.get(basePath);
    if (!cached) {
      cached = buildRequire(basePath);
      this.#requireCache.set(basePath, cached);
    }
    return cached;
  }
  filenameForUrl(moduleUrlOrPath) {
    if (!moduleUrlOrPath)
      return null;
    if (moduleUrlOrPath.startsWith("file://"))
      return fileURLToPath(moduleUrlOrPath);
    return path4.isAbsolute(moduleUrlOrPath) ? moduleUrlOrPath : null;
  }
  dirnameForUrl(moduleUrlOrPath, cwd) {
    const filename = this.filenameForUrl(moduleUrlOrPath);
    return filename ? path4.dirname(filename) : cwd;
  }
  async#resolveFromBase(baseDir, source) {
    const resolved = resolveImportSpecifier(baseDir, source);
    if (isLocalPathSpecifier(source) && isManagedLocalModulePath(resolved)) {
      const module = await this.#loadLocalModule(resolved);
      return { mode: "local", value: module.namespace };
    }
    return { mode: "external", target: normalizeImportTarget(resolved) };
  }
  async#ensureLocalModule(modulePath) {
    const existing = this.#moduleEntries.get(modulePath);
    if (existing)
      return existing;
    const building = this.#moduleBuilds.get(modulePath);
    if (building)
      return await building;
    const buildPromise = this.#buildLocalModule(modulePath).finally(() => {
      if (this.#moduleBuilds.get(modulePath) === buildPromise)
        this.#moduleBuilds.delete(modulePath);
    });
    this.#moduleBuilds.set(modulePath, buildPromise);
    return await buildPromise;
  }
  async#buildLocalModule(modulePath) {
    const rawSource = fs5.readFileSync(modulePath, "utf8");
    const stripped = stripTypeScriptSyntax(rawSource, {
      force: isTypeScriptModulePath(modulePath),
      loader: stripLoaderForPath(modulePath)
    });
    const moduleDir = path4.dirname(modulePath);
    const localDeps = new Set;
    for (const specifier of await collectModuleSourceSpecifiers(stripped)) {
      const resolved = resolveImportSpecifier(moduleDir, specifier);
      if (isLocalPathSpecifier(specifier) && isManagedLocalModulePath(resolved)) {
        localDeps.add(resolved);
      }
    }
    this.#setModuleDependencies(modulePath, localDeps);
    this.#moduleMtimes.set(modulePath, fs5.statSync(modulePath).mtimeMs);
    const version2 = this.#moduleVersions.get(modulePath) ?? 1;
    this.#moduleVersions.set(modulePath, version2);
    const fileUrl = pathToFileURL(modulePath).href;
    const identifier = `${fileUrl}?omp-session=${this.#sessionTag}&v=${version2}`;
    const wrappedSource = buildModuleSource(stripped, modulePath);
    const module = new vm.SourceTextModule(wrappedSource, {
      context: this.#context,
      identifier,
      initializeImportMeta: (meta) => {
        meta.url = fileUrl;
        meta.path = modulePath;
        meta.dir = moduleDir;
      },
      importModuleDynamically: async (specifier) => {
        return await this.#resolveDynamicImport(modulePath, String(specifier));
      }
    });
    this.#modulePaths.set(module, modulePath);
    const entry = { version: version2, identifier, module };
    this.#moduleEntries.set(modulePath, entry);
    return entry;
  }
  async#loadLocalModule(modulePath) {
    const entry = await this.#ensureLocalModule(modulePath);
    entry.loaded ??= this.#linkAndEvaluate(entry, modulePath);
    await entry.loaded;
    return entry.module;
  }
  async#linkAndEvaluate(entry, modulePath) {
    const { module } = entry;
    try {
      await this.#serializeLink(async () => {
        if (module.status === "unlinked")
          await module.link(this.#linkResolve);
      });
      if (module.status === "linked")
        await module.evaluate();
    } catch (error2) {
      this.#invalidateFailedLoad(modulePath);
      throw error2;
    }
    if (module.status === "errored") {
      this.#invalidateFailedLoad(modulePath);
      throw module.error;
    }
  }
  #serializeLink(run) {
    const result = this.#linkChain.then(run);
    this.#linkChain = result.then(() => {
      return;
    }, () => {
      return;
    });
    return result;
  }
  #linkResolve = async (specifier, referencingModule) => {
    const referrerPath = this.#modulePaths.get(referencingModule);
    if (referrerPath === undefined) {
      throw new Error(`local module loader: unknown referrer while linking "${specifier}"`);
    }
    const resolved = resolveImportSpecifier(path4.dirname(referrerPath), specifier);
    if (isLocalPathSpecifier(specifier) && isManagedLocalModulePath(resolved)) {
      return (await this.#ensureLocalModule(resolved)).module;
    }
    return await this.#ensureExternalModule(normalizeImportTarget(resolved));
  };
  async#resolveDynamicImport(referrerPath, specifier) {
    const resolved = resolveImportSpecifier(path4.dirname(referrerPath), specifier);
    if (isLocalPathSpecifier(specifier) && isManagedLocalModulePath(resolved)) {
      return await this.#loadLocalModule(resolved);
    }
    return await this.#ensureExternalModule(normalizeImportTarget(resolved));
  }
  #invalidateFailedLoad(rootPath) {
    const stack = [rootPath];
    const seen = new Set;
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined || seen.has(current))
        continue;
      seen.add(current);
      const entry = this.#moduleEntries.get(current);
      if (entry && entry.module.status === "evaluated")
        continue;
      this.#moduleEntries.delete(current);
      this.#moduleBuilds.delete(current);
      const deps = this.#moduleDeps.get(current);
      if (deps)
        for (const dep of deps)
          stack.push(dep);
    }
  }
  async#ensureExternalModule(target) {
    const existing = this.#externalModules.get(target);
    if (existing)
      return await existing;
    const loadPromise = (async () => {
      const namespace = await import(target);
      const exportNames = Object.keys(namespace);
      const module = new vm.SyntheticModule(exportNames, function() {
        for (const name of exportNames) {
          this.setExport(name, namespace[name]);
        }
      }, { context: this.#context, identifier: target });
      await module.link(() => {
        throw new Error("Synthetic external modules have no dependencies");
      });
      await module.evaluate();
      return module;
    })();
    this.#externalModules.set(target, loadPromise);
    try {
      return await loadPromise;
    } catch (error2) {
      if (this.#externalModules.get(target) === loadPromise)
        this.#externalModules.delete(target);
      throw error2;
    }
  }
  #refreshTrackedLocalModules() {
    const changed = [];
    for (const [modulePath, previousMtime] of this.#moduleMtimes.entries()) {
      let nextMtime;
      try {
        nextMtime = fs5.statSync(modulePath).mtimeMs;
      } catch {
        nextMtime = undefined;
      }
      if (nextMtime === previousMtime)
        continue;
      if (nextMtime === undefined)
        this.#moduleMtimes.delete(modulePath);
      else
        this.#moduleMtimes.set(modulePath, nextMtime);
      changed.push(modulePath);
    }
    for (const modulePath of changed) {
      this.#invalidateModuleAndParents(modulePath, new Set);
    }
  }
  #invalidateModuleAndParents(modulePath, seen) {
    if (seen.has(modulePath))
      return;
    seen.add(modulePath);
    this.#moduleEntries.delete(modulePath);
    this.#moduleBuilds.delete(modulePath);
    this.#moduleVersions.set(modulePath, (this.#moduleVersions.get(modulePath) ?? 1) + 1);
    const parents = [...this.#moduleParents.get(modulePath) ?? []];
    for (const parent of parents)
      this.#invalidateModuleAndParents(parent, seen);
  }
  #setModuleDependencies(modulePath, deps) {
    const previousDeps = this.#moduleDeps.get(modulePath);
    if (previousDeps) {
      for (const dep of previousDeps) {
        const parents = this.#moduleParents.get(dep);
        if (!parents)
          continue;
        parents.delete(modulePath);
        if (parents.size === 0)
          this.#moduleParents.delete(dep);
      }
    }
    this.#moduleDeps.set(modulePath, new Set(deps));
    for (const dep of deps) {
      const parents = this.#moduleParents.get(dep) ?? new Set;
      parents.add(modulePath);
      this.#moduleParents.set(dep, parents);
    }
  }
}
function buildRequire(fromPath) {
  const basePath = path4.extname(fromPath) ? fromPath : path4.join(fromPath, "[eval]");
  return createRequire(pathToFileURL(basePath).href);
}
function buildModuleSource(source, modulePath) {
  const moduleDir = path4.dirname(modulePath);
  return [
    `const require = globalThis.__omp_get_require__(${JSON.stringify(pathToFileURL(modulePath).href)});`,
    `const __filename = ${JSON.stringify(modulePath)};`,
    `const __dirname = ${JSON.stringify(moduleDir)};`,
    source
  ].join(`
`);
}
function resolveImportSpecifier(cwd, source) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(source))
    return source;
  try {
    return Bun.resolveSync(source, cwd);
  } catch {
    return source;
  }
}
function isLocalPathSpecifier(source) {
  return source.startsWith("./") || source.startsWith("../") || source === "." || source === ".." || source.startsWith("/") || source.startsWith("~/") || /^[a-zA-Z]:[\\/]/.test(source);
}
function isTypeScriptModulePath(modulePath) {
  const ext = path4.extname(modulePath);
  return ext === ".ts" || ext === ".tsx" || ext === ".mts";
}
function stripLoaderForPath(modulePath) {
  return path4.extname(modulePath) === ".tsx" ? "tsx" : "ts";
}
function isManagedLocalModulePath(target) {
  return path4.isAbsolute(target) && LOCAL_MODULE_EXTENSIONS.has(path4.extname(target)) && !target.includes(`${path4.sep}node_modules${path4.sep}`);
}
function normalizeImportTarget(target) {
  if (path4.isAbsolute(target))
    return pathToFileURL(target).href;
  return target;
}
var LOCAL_MODULE_EXTENSIONS;
var init_local_module_loader = __esm(() => {
  init_rewrite_imports();
  LOCAL_MODULE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".ts", ".tsx", ".mts"]);
});

// src/eval/js/shared/prelude.txt
var prelude_default = `if (!globalThis.__omp_js_prelude_loaded__) {
	globalThis.__omp_js_prelude_loaded__ = true;

	const isNil = value => value === undefined || value === null;
	const isPlainObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
	const positionalOptions = (name, args, keys, example) => {
		for (let index = keys.length; index < args.length; index++) {
			if (!isNil(args[index])) {
				throw new TypeError(
					\`\${name}() accepts at most \${keys.length} positional optional args; got \${args.length}. Pass \${name}(..., \${example}) for named options.\`,
				);
			}
		}
		const options = {};
		for (let index = 0; index < keys.length && index < args.length; index++) {
			const value = args[index];
			if (!isNil(value)) options[keys[index]] = value;
		}
		return options;
	};
	const optionsArg = (name, value, rest, keys, example) => {
		if (isNil(value)) return positionalOptions(name, [value, ...rest], keys, example);
		if (isPlainObject(value)) {
			if (rest.some(arg => !isNil(arg))) {
				throw new TypeError(
					\`\${name}() takes either a single trailing options object like \${example} or positional optional args; do not mix both forms.\`,
				);
			}
			return value;
		}
		if (typeof value === "object") {
			const kind = Array.isArray(value) ? "an array" : value.constructor?.name ?? "object";
			throw new TypeError(
				\`\${name}() options must be a plain object like \${example}, null/undefined, or positional optional args, not \${kind}.\`,
			);
		}
		return positionalOptions(name, [value, ...rest], keys, example);
	};
	const callHelper = (name, ...args) => globalThis.__omp_helpers__[name](...args);
	const hasScheme = path => typeof path === "string" && /^[A-Za-z][A-Za-z0-9+.-]*:\\/\\//.test(path);
	const shouldDelegateRead = path => hasScheme(path) && !path.toLowerCase().startsWith("local://");
	const withReadLineSelector = (path, options) => {
		const offset = typeof options.offset === "number" ? options.offset : 1;
		const limit = typeof options.limit === "number" ? options.limit : undefined;
		if (offset <= 1 && limit === undefined) return path;
		if (limit !== undefined && limit <= 0) return null;
		const start = Math.max(1, offset);
		if (limit === undefined) return \`\${path}:\${start}-\`;
		return \`\${path}:\${start}-\${start + limit - 1}\`;
	};
	const readToolText = async path => {
		const res = await globalThis.__omp_call_tool__("read", { path });
		return res && typeof res === "object" && "text" in res ? res.text : res;
	};


	const read = async (path, opts, ...rest) => {
		const options = optionsArg("read", opts, rest, ["offset", "limit"], "{ offset, limit }");
		if (shouldDelegateRead(path)) {
			const toolPath = withReadLineSelector(path, options);
			return toolPath === null ? "" : readToolText(toolPath);
		}
		return callHelper("read", path, options);
	};
	const write = async (path, data) => callHelper("writeFile", path, data);
	const env = (key, value) => callHelper("env", key, value);

	const tool = new Proxy(
		{},
		{
			get(_target, prop) {
				if (typeof prop !== "string") return undefined;
				return async args => globalThis.__omp_call_tool__(prop, args ?? {});
			},
		},
	);

	const output = async (...args) => {
		let opts = {};
		let ids = args;
		if (args.length > 0) {
			const last = args.at(-1);
			if (last && typeof last === "object" && !Array.isArray(last)) {
				opts = last;
				ids = args.slice(0, -1);
			}
		}
		const reads = ids.map(id => tool.read({ path: \`agent://\${id}\`, ...opts }));
		const values = await Promise.all(reads);
		return values.length === 1 ? values[0] : values;
	};

	const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

	const completion = async (prompt, opts, ...rest) => {
		const o = optionsArg("completion", opts, rest, ["model", "system", "schema"], "{ model, system, schema }");
		const res = await globalThis.__omp_call_tool__("__completion__", { prompt, ...o });
		const text = res && typeof res === "object" ? res.text : res;
		return hasOwn(o, "schema") ? JSON.parse(text) : text;
	};

	const agent = async (prompt, opts, ...rest) => {
		const o = optionsArg(
			"agent",
			opts,
			rest,
			["agent", "model", "label", "schema", "isolated", "apply", "merge", "schemaMode"],
			"{ agent, model, label, schema, isolated, apply, merge, schemaMode, handle }",
		);
		const { handle, ...callArgs } = o;
		const res = await globalThis.__omp_call_tool__("__agent__", { prompt, ...callArgs, handle: Boolean(handle) });
		const text = res && typeof res === "object" ? res.text : res;
		const hasData = res && typeof res === "object" && hasOwn(res, "data");
		const parsed = hasData ? res.data : hasOwn(callArgs, "schema") ? JSON.parse(text) : text;
		if (!handle) return parsed;
		const details = res && typeof res === "object" ? res.details : undefined;
		if (!details || typeof details !== "object" || details.id == null) {
			return { text, output: text, handle: null, id: null, agent: null };
		}
		const node = { text, output: text, handle: \`agent://\${details.id}\`, id: details.id, agent: details.agent ?? null };
		if (hasData || hasOwn(callArgs, "schema")) node.data = parsed;
		for (const key of ["isolated", "patchPath", "branchName", "nestedPatches", "changesApplied", "isolationSummary"]) {
			if (details[key] !== undefined) node[key] = details[key];
		}
		return node;
	};

	// Pool ceiling mirrors the task tool's \`task.maxConcurrency\` setting so an
	// eval fan-out runs as wide as a \`task\` batch would. 0 (and any non-finite
	// reply) means unbounded \u2014 run every item at once.
	const __concurrencyLimit = async () => {
		try {
			const r = await globalThis.__omp_call_tool__("__concurrency__", {});
			const n = Math.trunc(Number(r && typeof r === "object" ? r.limit : r));
			return Number.isFinite(n) && n > 0 ? n : 0;
		} catch {
			return 0;
		}
	};

	const __pool = async (items, fn) => {
		const list = Array.from(items ?? []);
		if (list.length === 0) return [];
		const limit = await __concurrencyLimit();
		const concurrency = limit > 0 ? Math.min(limit, list.length) : list.length;
		const results = new Array(list.length);
		// Barrier semantics (mirrors the Python _pool_map): every item settles
		// before we return or throw, then the lowest-index error propagates.
		// Early-rejecting would orphan in-flight thunks (e.g. live agent()
		// subagents) whose worker-side promises would never be observed.
		const errors = new Map();
		let next = 0;
		const worker = async () => {
			while (true) {
				const index = next++;
				if (index >= list.length) return;
				try {
					results[index] = await fn(list[index], index);
				} catch (error) {
					errors.set(index, error);
				}
			}
		};
		await Promise.all(Array.from({ length: concurrency }, () => worker()));
		if (errors.size > 0) throw errors.get(Math.min(...errors.keys()));
		return results;
	};

	const parallel = async thunks =>
		__pool(thunks, (thunk, index) => {
			if (typeof thunk !== "function") throw new TypeError("parallel() expects an iterable of functions");
			return thunk(index);
		});

	const pipeline = async (items, ...stages) => {
		let current = Array.from(items ?? []);
		for (const stage of stages) {
			if (typeof stage !== "function") throw new TypeError("pipeline() stages must be functions");
			current = await __pool(current, stage);
		}
		return current;
	};

	const log = message => globalThis.__omp_emit_status__("log", { message: String(message) });

	const phase = title => {
		globalThis.__omp_phase__ = String(title);
		globalThis.__omp_emit_status__("phase", { title: String(title) });
	};

	const __budgetSnap = async () => {
		const r = await globalThis.__omp_call_tool__("__budget__", {});
		return r && typeof r === "object" ? r : {};
	};

	const budget = {
		total: async () => {
			const s = await __budgetSnap();
			return s.total ?? null;
		},
		spent: async () => Number((await __budgetSnap()).spent ?? 0),
		remaining: async () => {
			const s = await __budgetSnap();
			return s.total == null ? Infinity : Math.max(0, Number(s.total) - Number(s.spent ?? 0));
		},
		hard: async () => Boolean((await __budgetSnap()).hard),
	};

	const display = value => {
		globalThis.__omp_display__(value);
	};

	const formatArgs = args => args.map(arg => (typeof arg === "string" ? arg : arg));

	const consoleTimers = new Map();
	const consoleCounts = new Map();
	const consoleBridge = {
		log: (...args) => globalThis.__omp_log__("log", ...formatArgs(args)),
		info: (...args) => globalThis.__omp_log__("info", ...formatArgs(args)),
		warn: (...args) => globalThis.__omp_log__("warn", ...formatArgs(args)),
		error: (...args) => globalThis.__omp_log__("error", ...formatArgs(args)),
		debug: (...args) => globalThis.__omp_log__("debug", ...formatArgs(args)),
		table: (data, columns) =>
			columns === undefined
				? globalThis.__omp_table__(data)
				: globalThis.__omp_table__(data, columns),
		dir: (value, _options) => globalThis.__omp_log__("log", value),
		dirxml: (...args) => globalThis.__omp_log__("log", ...formatArgs(args)),
		trace: (...args) => {
			const stack = (new Error().stack ?? "").split("\\n").slice(2).join("\\n");
			globalThis.__omp_log__("log", args.length > 0 ? \`Trace: \${formatArgs(args).join(" ")}\` : "Trace", \`\\n\${stack}\`);
		},
		assert: (condition, ...args) => {
			if (condition) return;
			if (args.length > 0) globalThis.__omp_log__("error", "Assertion failed:", ...formatArgs(args));
			else globalThis.__omp_log__("error", "Assertion failed");
		},
		group: (...args) => {
			if (args.length > 0) globalThis.__omp_log__("log", ...formatArgs(args));
		},
		groupCollapsed: (...args) => {
			if (args.length > 0) globalThis.__omp_log__("log", ...formatArgs(args));
		},
		groupEnd: () => {},
		time: label => {
			consoleTimers.set(String(label ?? "default"), Date.now());
		},
		timeLog: (label, ...args) => {
			const key = String(label ?? "default");
			const start = consoleTimers.get(key);
			if (start === undefined) {
				globalThis.__omp_log__("warn", \`Timer '\${key}' does not exist\`);
				return;
			}
			globalThis.__omp_log__("log", \`\${key}: \${Date.now() - start}ms\`, ...formatArgs(args));
		},
		timeEnd: label => {
			const key = String(label ?? "default");
			const start = consoleTimers.get(key);
			if (start === undefined) {
				globalThis.__omp_log__("warn", \`Timer '\${key}' does not exist\`);
				return;
			}
			consoleTimers.delete(key);
			globalThis.__omp_log__("log", \`\${key}: \${Date.now() - start}ms\`);
		},
		count: label => {
			const key = String(label ?? "default");
			const next = (consoleCounts.get(key) ?? 0) + 1;
			consoleCounts.set(key, next);
			globalThis.__omp_log__("log", \`\${key}: \${next}\`);
		},
		countReset: label => {
			consoleCounts.delete(String(label ?? "default"));
		},
	};

	globalThis.console = consoleBridge;
	globalThis.print = consoleBridge.log;
	globalThis.display = display;
	globalThis.tool = tool;
	globalThis.completion = completion;
	globalThis.output = output;
	globalThis.agent = agent;
	globalThis.parallel = parallel;
	globalThis.pipeline = pipeline;
	globalThis.log = log;
	globalThis.phase = phase;
	globalThis.budget = budget;
	globalThis.__pool = __pool;
	globalThis.read = read;
	globalThis.write = write;
	globalThis.env = env;
}
`;
var init_prelude = () => {};

// src/eval/js/shared/prelude.ts
var JAVASCRIPT_PRELUDE_SOURCE;
var init_prelude2 = __esm(() => {
  init_prelude();
  JAVASCRIPT_PRELUDE_SOURCE = prelude_default;
});

// src/eval/js/shared/runtime.ts
import { AsyncLocalStorage as AsyncLocalStorage2 } from "async_hooks";
import { Console } from "console";
import * as fs6 from "fs";
import { createRequire as createRequire2 } from "module";
import * as path5 from "path";
import { Writable } from "stream";
import * as util from "util";
function isStrictBase64(s) {
  if (s.length === 0 || s.length % 4 !== 0)
    return false;
  return BASE64_STRICT_RE.test(s);
}
function coerceImageBase64(data) {
  if (typeof data === "string") {
    if (isStrictBase64(data))
      return data;
    if (DECIMAL_CSV_RE.test(data)) {
      const parts = data.split(",");
      const bytes = new Uint8Array(parts.length);
      for (let i = 0;i < parts.length; i++) {
        const n = Number(parts[i]);
        if (!Number.isInteger(n) || n < 0 || n > 255)
          return null;
        bytes[i] = n;
      }
      return Buffer.from(bytes).toString("base64");
    }
    return null;
  }
  if (data instanceof Uint8Array)
    return Buffer.from(data).toString("base64");
  if (data instanceof ArrayBuffer)
    return Buffer.from(data).toString("base64");
  if (ArrayBuffer.isView(data)) {
    const view = data;
    return Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString("base64");
  }
  if (data && typeof data === "object") {
    const obj = data;
    if (obj.type === "Buffer" && Array.isArray(obj.data)) {
      const arr = obj.data;
      const bytes = new Uint8Array(arr.length);
      for (let i = 0;i < arr.length; i++) {
        const n = arr[i];
        if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 255)
          return null;
        bytes[i] = n;
      }
      return Buffer.from(bytes).toString("base64");
    }
  }
  return null;
}
function describeDataType(data) {
  if (data === null)
    return "null";
  if (data instanceof Uint8Array)
    return "Uint8Array";
  if (data instanceof ArrayBuffer)
    return "ArrayBuffer";
  if (ArrayBuffer.isView(data))
    return data.constructor.name;
  if (typeof data === "string")
    return `string(${data.length})`;
  return typeof data;
}

class JsRuntime {
  #globalOwner = Symbol("JsRuntime globals");
  #ownedGlobalKeys = new Set;
  #disposed = false;
  #runHookResolver = () => this.#als.getStore()?.hooks;
  #ownGlobal(key) {
    if (this.#ownedGlobalKeys.has(key))
      return;
    claimGlobalKey(key, this.#globalOwner);
    this.#ownedGlobalKeys.add(key);
  }
  #activateGlobals(action) {
    if (this.#disposed)
      throw new Error(`Cannot ${action} on a disposed JS runtime`);
    activateGlobalOwner(this.#globalOwner, this.#ownedGlobalKeys, action);
  }
  helpers;
  #cwd;
  #session;
  sessionId;
  #env;
  #als = new AsyncLocalStorage2;
  #moduleLoader;
  #localRoots;
  constructor(opts) {
    this.#cwd = opts.initialCwd;
    this.#session = { cwd: opts.initialCwd, sessionId: opts.sessionId };
    this.sessionId = opts.sessionId;
    this.#env = new Map;
    this.#moduleLoader = new LocalModuleLoader(this.sessionId);
    this.#localRoots = opts.localRoots ?? {};
    this.helpers = createHelpers({
      cwd: () => this.#activeCwd(),
      env: this.#env,
      localRoots: () => this.#localRoots,
      emitStatus: (event) => this.#activeHooks("emitStatus")?.onDisplay({ type: "status", event })
    });
    this.#install(opts.extraGlobals);
  }
  get cwd() {
    return this.#cwd;
  }
  setCwd(cwd) {
    if (this.#disposed)
      throw new Error("Cannot set cwd on a disposed JS runtime");
    this.#cwd = cwd;
    this.#session.cwd = cwd;
    if (activeGlobalRunOwner === null || activeGlobalRunOwner === this.#globalOwner) {
      this.#activateGlobals("set cwd");
    }
  }
  setRunScope(scope) {
    this.#activateGlobals("set run scope");
    Object.assign(globalThis, scope);
  }
  async run(code, filename, hooks, options = {}) {
    this.#activateGlobals("run code");
    const leaveRun = enterGlobalRun(this.#globalOwner, "run code");
    const context = {
      runId: options.runId ?? crypto.randomUUID(),
      hooks,
      cwd: options.cwd ?? this.#cwd,
      finalExpressionSet: false,
      finalExpressionValue: undefined
    };
    try {
      return await this.#als.run(context, async () => {
        const wrapped = await wrapCode(code);
        const value = indirectEval(wrapped.source, filename);
        if (wrapped.finalExpressionReturned) {
          const awaited = await awaitMaybePromise(value);
          if (context.finalExpressionSet) {
            const finalValue = context.finalExpressionValue;
            context.finalExpressionSet = false;
            context.finalExpressionValue = undefined;
            return await awaitMaybePromise(finalValue);
          }
          return awaited;
        }
        return await awaitMaybePromise(value);
      });
    } finally {
      leaveRun();
    }
  }
  displayValue(value, hooks = this.#als.getStore()?.hooks) {
    if (value === undefined)
      return;
    if (!hooks) {
      warn("js runtime display called outside an active run");
      return;
    }
    if (value && typeof value === "object") {
      const record = value;
      if (record.type === "image" && typeof record.mimeType === "string") {
        const data = coerceImageBase64(record.data);
        if (data !== null) {
          hooks.onDisplay({ type: "image", data, mimeType: record.mimeType });
          return;
        }
        warn("js displayValue: dropping image with unrecognized data shape", {
          mimeType: record.mimeType,
          dataType: describeDataType(record.data)
        });
        hooks.onText(`[display: image dropped \u2014 \`data\` must be a base64 string, Uint8Array/Buffer, or ArrayBuffer; got ${describeDataType(record.data)}]
`);
        return;
      }
      try {
        hooks.onDisplay({ type: "json", data: structuredClone(value) });
      } catch (err) {
        debug("js displayValue: value is not structured-cloneable, falling back to text", {
          error: err instanceof Error ? err.message : String(err)
        });
        hooks.onText(`${Object.prototype.toString.call(value)}
`);
      }
      return;
    }
    hooks.onText(`${String(value)}
`);
  }
  #activeCwd() {
    return this.#als.getStore()?.cwd ?? this.#cwd;
  }
  #activeHooks(action) {
    const hooks = this.#als.getStore()?.hooks;
    if (!hooks) {
      warn("js runtime helper called outside an active run", { action });
    }
    return hooks;
  }
  #activeRequire(moduleUrlOrPath) {
    return this.#moduleLoader.requireForFile(moduleUrlOrPath, this.#activeCwd());
  }
  #moduleFilename(moduleUrlOrPath) {
    return this.#moduleLoader.filenameForUrl(moduleUrlOrPath) ?? path5.join(this.#activeCwd(), "[eval]");
  }
  #moduleDirname(moduleUrlOrPath) {
    return this.#moduleLoader.dirnameForUrl(moduleUrlOrPath, this.#activeCwd());
  }
  #buildDynamicRequire() {
    const dynamicRequire = (id) => this.#activeRequire()(id);
    const resolve3 = (id, options) => this.#activeRequire().resolve(id, options);
    resolve3.paths = (request) => this.#activeRequire().resolve.paths(request);
    Object.defineProperties(dynamicRequire, {
      resolve: { value: resolve3, configurable: true },
      cache: { get: () => this.#activeRequire().cache, configurable: true },
      extensions: { get: () => this.#activeRequire().extensions, configurable: true },
      main: { get: () => this.#activeRequire().main, configurable: true }
    });
    return dynamicRequire;
  }
  #install(extraGlobals) {
    assertCanUseGlobalOwner(this.#globalOwner, "initialize a JS runtime");
    const injected = {
      __omp_session__: this.#session,
      __omp_helpers__: this.helpers,
      __omp_call_tool__: async (name, args) => {
        const hooks = this.#activeHooks("tool");
        if (!hooks)
          return;
        return await hooks.callTool(name, args);
      },
      __omp_import__: async (source, options) => {
        const resolved = await this.#moduleLoader.resolveForRun(this.#activeCwd(), source);
        if (resolved.mode === "local")
          return resolved.value;
        const target = resolved.target;
        return options !== undefined ? await import(target, options) : await import(target);
      },
      __omp_import_from__: async (moduleUrl, source, options) => {
        const resolved = await this.#moduleLoader.resolveForModule(moduleUrl, source, this.#activeCwd());
        if (resolved.mode === "local")
          return resolved.value;
        const target = resolved.target;
        return options !== undefined ? await import(target, options) : await import(target);
      },
      __omp_get_require__: (moduleUrl) => this.#activeRequire(moduleUrl),
      __omp_get_filename__: (moduleUrl) => this.#moduleFilename(moduleUrl),
      __omp_get_dirname__: (moduleUrl) => this.#moduleDirname(moduleUrl),
      __omp_emit_status__: (op, data = {}) => {
        const event = { op, ...data };
        this.#activeHooks("emitStatus")?.onDisplay({ type: "status", event });
      },
      __omp_log__: (level, ...args) => {
        const prefix = level === "error" ? "[error] " : level === "warn" ? "[warn] " : "";
        const text = `${prefix}${formatConsoleArgs(args)}`;
        this.#activeHooks("log")?.onText(text.endsWith(`
`) ? text : `${text}
`);
      },
      __omp_table__: (...args) => {
        const hooks = this.#activeHooks("table");
        if (!hooks)
          return;
        let buffer = "";
        const stream = new Writable({
          write(chunk, _enc, cb) {
            buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
            cb();
          }
        });
        const tableConsole = new Console({ stdout: stream, colorMode: false });
        tableConsole.table(...args);
        hooks.onText(buffer.endsWith(`
`) ? buffer : `${buffer}
`);
      },
      __omp_display__: (value) => this.displayValue(value),
      __omp_set_final_expr__: (value) => {
        const context = this.#als.getStore();
        if (!context) {
          warn("js runtime final expression set outside an active run");
          return;
        }
        context.finalExpressionSet = true;
        context.finalExpressionValue = value;
      },
      webcrypto: crypto,
      require: this.#buildDynamicRequire(),
      createRequire: createRequire2,
      fs: fs6
    };
    const allGlobalKeys = new Set([
      ...Object.keys(injected),
      ...Object.keys(extraGlobals ?? {}),
      ...PRELUDE_GLOBAL_KEYS
    ]);
    for (const key of allGlobalKeys) {
      this.#ownGlobal(key);
    }
    Object.assign(globalThis, injected, extraGlobals ?? {});
    indirectEval(JAVASCRIPT_PRELUDE_SOURCE);
    for (const key of allGlobalKeys)
      recordGlobalValue(key, this.#globalOwner);
    RUN_HOOK_RESOLVERS.add(this.#runHookResolver);
    patchStdioOnce();
  }
  dispose() {
    if (this.#disposed)
      return;
    this.#disposed = true;
    RUN_HOOK_RESOLVERS.delete(this.#runHookResolver);
    for (const key of this.#ownedGlobalKeys)
      releaseGlobalKey(key, this.#globalOwner);
    this.#ownedGlobalKeys.clear();
  }
}
function snapshotGlobal(key) {
  return {
    exists: key in globalThis,
    value: globalThis[key]
  };
}
function restoreGlobal(key, state) {
  if (state.exists) {
    globalThis[key] = state.value;
  } else {
    delete globalThis[key];
  }
}
function claimGlobalKey(key, owner) {
  let stack = GLOBAL_STACKS.get(key);
  if (!stack) {
    stack = { base: snapshotGlobal(key), entries: [] };
    GLOBAL_STACKS.set(key, stack);
  }
  stack.entries.push({ owner, value: globalThis[key] });
}
function recordGlobalValue(key, owner) {
  const stack = GLOBAL_STACKS.get(key);
  const entry = stack?.entries.findLast((item) => item.owner === owner);
  if (entry)
    entry.value = globalThis[key];
}
function releaseGlobalKey(key, owner) {
  const stack = GLOBAL_STACKS.get(key);
  if (!stack)
    return;
  const index = stack.entries.findIndex((entry) => entry.owner === owner);
  if (index === -1)
    return;
  const wasTop = index === stack.entries.length - 1;
  stack.entries.splice(index, 1);
  if (!wasTop)
    return;
  const next = stack.entries.at(-1);
  if (next) {
    globalThis[key] = next.value;
    return;
  }
  restoreGlobal(key, stack.base);
  GLOBAL_STACKS.delete(key);
}
function assertCanUseGlobalOwner(owner, action) {
  if (activeGlobalRunOwner === null || activeGlobalRunOwner === owner)
    return;
  throw new Error(`Cannot ${action} while another same-realm JS runtime is running`);
}
function activateGlobalOwner(owner, keys, action) {
  assertCanUseGlobalOwner(owner, action);
  for (const key of keys) {
    const stack = GLOBAL_STACKS.get(key);
    const index = stack?.entries.findIndex((entry2) => entry2.owner === owner) ?? -1;
    if (!stack || index === -1)
      throw new Error(`Cannot ${action} on a disposed JS runtime`);
    const entry = stack.entries[index];
    stack.entries.splice(index, 1);
    stack.entries.push(entry);
    globalThis[key] = entry.value;
  }
}
function enterGlobalRun(owner, action) {
  assertCanUseGlobalOwner(owner, action);
  activeGlobalRunOwner = owner;
  activeGlobalRunDepth++;
  let left = false;
  return () => {
    if (left)
      return;
    left = true;
    activeGlobalRunDepth--;
    if (activeGlobalRunDepth === 0)
      activeGlobalRunOwner = null;
  };
}
function activeRunHooks() {
  for (const resolve3 of RUN_HOOK_RESOLVERS) {
    const hooks = resolve3();
    if (hooks)
      return hooks;
  }
  return;
}
function patchStdioOnce() {
  const streams = [process.stdout, process.stderr];
  for (const stream of streams) {
    if (!stream || PATCHED_STDIO_STREAMS.has(stream))
      continue;
    PATCHED_STDIO_STREAMS.add(stream);
    const original = stream.write.bind(stream);
    const routed = (chunk, encoding, callback) => {
      const hooks = activeRunHooks();
      if (!hooks)
        return original(chunk, encoding, callback);
      const cb = typeof encoding === "function" ? encoding : callback;
      const enc = typeof encoding === "string" ? encoding : undefined;
      hooks.onText(chunkToString(chunk, enc));
      if (typeof cb === "function")
        cb();
      return true;
    };
    stream.write = routed;
  }
}
function chunkToString(chunk, encoding) {
  if (typeof chunk === "string")
    return chunk;
  if (chunk instanceof Uint8Array)
    return Buffer.from(chunk).toString(encoding ?? "utf8");
  return String(chunk);
}
function formatConsoleArgs(args) {
  return args.map((arg) => typeof arg === "string" ? arg : util.inspect(arg, { depth: 6, colors: false, breakLength: 120 })).join(" ");
}
var BASE64_STRICT_RE, DECIMAL_CSV_RE, PRELUDE_GLOBAL_KEYS, GLOBAL_STACKS, activeGlobalRunOwner = null, activeGlobalRunDepth = 0, RUN_HOOK_RESOLVERS, PATCHED_STDIO_STREAMS;
var init_runtime = __esm(() => {
  init_logger();
  init_helpers();
  init_local_module_loader();
  init_prelude2();
  init_rewrite_imports();
  BASE64_STRICT_RE = /^[A-Za-z0-9+/]+={0,2}$/;
  DECIMAL_CSV_RE = /^\d{1,3}(?:,\d{1,3})*$/;
  PRELUDE_GLOBAL_KEYS = [
    "__omp_js_prelude_loaded__",
    "console",
    "print",
    "display",
    "tool",
    "completion",
    "output",
    "agent",
    "parallel",
    "pipeline",
    "log",
    "phase",
    "budget",
    "__pool",
    "read",
    "write",
    "env"
  ];
  GLOBAL_STACKS = new Map;
  RUN_HOOK_RESOLVERS = new Set;
  PATCHED_STDIO_STREAMS = new WeakSet;
});

// src/utils/mac-file-urls.applescript
var init_mac_file_urls = () => {};

// src/utils/clipboard.ts
import {
  copyToClipboard as nativeCopyToClipboard,
  readImageFromClipboard as nativeReadImageFromClipboard
} from "@oh-my-pi/pi-natives/clipboard";
async function spawnCapture(cmd, options = {}) {
  const timeoutMs = options.timeoutMs ?? 2000;
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "ignore",
    stdin: options.input !== undefined ? Buffer.from(options.input) : "ignore"
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  try {
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    if (timedOut) {
      throw new Error(`${cmd[0]} timed out after ${timeoutMs}ms`);
    }
    if (proc.exitCode !== 0) {
      throw new Error(`${cmd[0]} exited with code ${proc.exitCode}`);
    }
    return stdout;
  } finally {
    clearTimeout(timer);
  }
}
function isWsl() {
  return process.platform === "linux" && Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}
async function copyToClipboard(text) {
  if (process.stdout.isTTY) {
    const onError = (err) => {
      process.stdout.off("error", onError);
      if (err?.code === "EPIPE") {
        return;
      }
    };
    try {
      const encoded = Buffer.from(text).toString("base64");
      const osc52 = `\x1B]52;c;${encoded}\x07`;
      process.stdout.on("error", onError);
      process.stdout.write(osc52, (err) => {
        process.stdout.off("error", onError);
        if (err?.code === "EPIPE") {
          return;
        }
      });
    } catch (err) {
      process.stdout.off("error", onError);
      if (err?.code !== "EPIPE") {}
    }
  }
  try {
    if (process.env.TERMUX_VERSION) {
      try {
        await spawnCapture(["termux-clipboard-set"], { input: text, timeoutMs: 5000 });
        return;
      } catch {}
    }
    await nativeCopyToClipboard(text);
  } catch {}
}
async function readTextViaPowerShell() {
  try {
    const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", POWERSHELL_TEXT_SCRIPT], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore"
    });
    const timer = setTimeout(() => proc.kill(), POWERSHELL_TIMEOUT_MS);
    let stdout = "";
    try {
      stdout = await new Response(proc.stdout).text();
      await proc.exited;
    } catch (err) {
      warn("clipboard: powershell text read failed", { error: String(err) });
      return null;
    } finally {
      clearTimeout(timer);
    }
    if (proc.exitCode !== 0)
      return null;
    return stdout.replaceAll(`\r
`, `
`);
  } catch {
    return null;
  }
}
async function readTextFromClipboard() {
  try {
    const p = process.platform;
    if (p === "darwin") {
      return await spawnCapture(["pbpaste"]);
    }
    if (p === "win32") {
      return await readTextViaPowerShell() ?? "";
    }
    if (process.env.TERMUX_VERSION) {
      return await spawnCapture(["termux-clipboard-get"]);
    }
    if (isWsl()) {
      const text = await readTextViaPowerShell();
      if (text !== null)
        return text;
    }
    const hasWaylandDisplay = Boolean(process.env.WAYLAND_DISPLAY);
    const hasX11Display = Boolean(process.env.DISPLAY);
    if (hasWaylandDisplay) {
      try {
        return await spawnCapture(["wl-paste", "--type", "text/plain", "--no-newline"]);
      } catch {
        if (hasX11Display) {
          return await spawnCapture(["xclip", "-selection", "clipboard", "-o"]);
        }
      }
    } else if (hasX11Display) {
      return await spawnCapture(["xclip", "-selection", "clipboard", "-o"]);
    }
  } catch (error2) {
    warn("clipboard: failed to read clipboard text", { error: String(error2) });
  }
  return "";
}
var POWERSHELL_TIMEOUT_MS = 8000, POWERSHELL_TEXT_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
[Console]::Out.Write([string](Get-Clipboard -Raw))
`;
var init_clipboard = __esm(() => {
  init_logger();
  init_mac_file_urls();
});

// src/tools/browser/run-output.ts
class RunOutput {
  #displays = [];
  #textBuffer = "";
  pushText(chunk) {
    this.#textBuffer += chunk;
  }
  pushDisplay(output) {
    if (output.type === "image") {
      this.push({ type: "image", data: output.data, mimeType: output.mimeType });
      return;
    }
    if (output.type === "json") {
      this.push({ type: "text", text: safeJsonStringify(output.data) });
      return;
    }
    this.push({ type: "text", text: safeJsonStringify(output.event) });
  }
  push(entry) {
    this.#flush();
    this.#displays.push(entry);
  }
  finish() {
    this.#flush();
    return this.#displays;
  }
  #flush() {
    if (!this.#textBuffer)
      return;
    this.#displays.push({ type: "text", text: this.#textBuffer.replace(/\n$/, "") });
    this.#textBuffer = "";
  }
}
function safeJsonStringify(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
function cloneSafe(value) {
  if (value === undefined)
    return;
  try {
    structuredClone(value);
    return value;
  } catch {}
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {}
  return String(value);
}

// ../utils/src/abortable.ts
import assert from "assert/strict";
function untilAborted(signal, pr) {
  if (!signal)
    return typeof pr === "function" ? pr() : pr;
  if (signal.aborted)
    return Promise.reject(new AbortError(signal));
  const { promise, resolve: resolve3, reject } = Promise.withResolvers();
  const onAbort = () => reject(new AbortError(signal));
  signal.addEventListener("abort", onAbort, { once: true });
  (async () => {
    try {
      resolve3(await (typeof pr === "function" ? pr() : pr));
    } catch (err) {
      reject(err);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  })();
  return promise;
}
var AbortError;
var init_abortable = __esm(() => {
  AbortError = class AbortError extends Error {
    constructor(signal) {
      assert(signal.aborted, "Abort signal must be aborted");
      const message = signal.reason instanceof Error ? signal.reason.message : "Cancelled";
      super(`Aborted: ${message}`, { cause: signal.reason });
      this.name = "AbortError";
    }
  };
});

// src/tools/run-scope.ts
function markHandled(promise) {
  promise.catch(() => {
    return;
  });
  return promise;
}
function resolvePredicateTimeout(cellTimeoutMs, explicit) {
  const budgetBound = Math.max(1, cellTimeoutMs - CELL_BUDGET_SLACK_MS);
  if (explicit === 0 || explicit === Number.POSITIVE_INFINITY)
    return budgetBound;
  if (explicit !== undefined && Number.isFinite(explicit) && explicit > 0)
    return Math.min(explicit, budgetBound);
  return Math.min(DEFAULT_PREDICATE_TIMEOUT_MS, budgetBound);
}
function waitForRun(msOrPredicate, signal, opts) {
  const promise = (async () => {
    throwIfAborted(signal);
    if (typeof msOrPredicate === "number") {
      await untilAborted(signal, async () => await Bun.sleep(msOrPredicate));
      throwIfAborted(signal);
      return;
    }
    if (typeof msOrPredicate !== "function") {
      throw new ToolError("wait(...) expects milliseconds (number) or a predicate function to poll");
    }
    const timeout = opts?.timeout !== undefined && Number.isFinite(opts.timeout) && opts.timeout > 0 ? opts.timeout : DEFAULT_PREDICATE_TIMEOUT_MS;
    const interval = Math.max(opts?.interval ?? 100, 10);
    const deadline = Date.now() + timeout;
    for (;; ) {
      const value = await untilAborted(signal, async () => await msOrPredicate());
      throwIfAborted(signal);
      if (value)
        return value;
      if (Date.now() + interval > deadline) {
        throw new ToolError(`wait(predicate) timed out after ${timeout}ms \u2014 predicate never returned truthy`);
      }
      await untilAborted(signal, async () => await Bun.sleep(interval));
    }
  })();
  return markHandled(promise);
}
function bindRunFacade(target, signal) {
  const cache = new Map;
  return new Proxy(target, {
    get(current, prop) {
      throwIfAborted(signal);
      const cached = cache.get(prop);
      if (cached)
        return cached;
      const value = Reflect.get(current, prop, current);
      if (typeof value === "function") {
        const wrapped = (...args) => {
          throwIfAborted(signal);
          const result = Reflect.apply(value, current, args);
          if (result && typeof result === "object") {
            const then = Reflect.get(result, "then");
            if (typeof then === "function") {
              return markHandled(Promise.resolve(result).then((resolved) => {
                throwIfAborted(signal);
                return resolved;
              }));
            }
          }
          throwIfAborted(signal);
          return result;
        };
        cache.set(prop, wrapped);
        return wrapped;
      }
      if (value && typeof value === "object") {
        if (value instanceof AbortSignal)
          return value;
        const wrapped = bindRunFacade(value, signal);
        cache.set(prop, wrapped);
        return wrapped;
      }
      return value;
    }
  });
}
var CELL_BUDGET_SLACK_MS = 1000, DEFAULT_PREDICATE_TIMEOUT_MS = 30000;
var init_run_scope = __esm(() => {
  init_abortable();
  init_tool_errors();
});

// src/tools/computer/worker.ts
import { AsyncLocalStorage as AsyncLocalStorage3 } from "async_hooks";
import * as os3 from "os";
import * as path6 from "path";
import { createDesktopSession } from "@oh-my-pi/pi-natives/desktop";
function errorPayload(error2) {
  if (error2 instanceof ToolAbortError) {
    return { name: error2.name, message: error2.message, stack: error2.stack, isToolError: false, isAbort: true };
  }
  if (error2 instanceof ToolError) {
    return { name: error2.name, message: error2.message, stack: error2.stack, isToolError: true, isAbort: false };
  }
  if (error2 instanceof Error) {
    return { name: error2.name, message: error2.message, stack: error2.stack, isToolError: false, isAbort: false };
  }
  return { name: "Error", message: String(error2), isToolError: false, isAbort: false };
}
function replyError(payload) {
  if (payload.isAbort) {
    const error3 = new ToolAbortError(payload.message || "Tool call aborted");
    if (payload.stack)
      error3.stack = payload.stack;
    return error3;
  }
  const ErrorType = payload.isToolError ? ToolError : Error;
  const error2 = new ErrorType(payload.message);
  if (payload.name)
    error2.name = payload.name;
  if (payload.stack)
    error2.stack = payload.stack;
  return error2;
}
function nativeError(error2) {
  return new ToolError(error2 instanceof Error ? error2.message : String(error2));
}
async function nativeCall(signal, call) {
  throwIfAborted(signal);
  try {
    const value = await call();
    throwIfAborted(signal);
    return value;
  } catch (error2) {
    if (error2 instanceof ToolAbortError)
      throw error2;
    throw nativeError(error2);
  }
}
function pointerOptions(options) {
  if (!options)
    return;
  const mapped = {};
  if ("button" in options && options.button !== undefined)
    mapped.button = options.button;
  if ("count" in options && options.count !== undefined)
    mapped.count = options.count;
  if ("modifiers" in options && options.modifiers !== undefined)
    mapped.modifiers = options.modifiers;
  if (options.delivery !== undefined)
    mapped.deliveryMode = options.delivery;
  return mapped;
}
function chordKeys(chord) {
  return typeof chord === "string" ? chord.split("+").map((key) => key.trim()).filter(Boolean) : chord;
}
function matchesFilter(window2, filter) {
  if (!filter)
    return true;
  const app = filter.app?.toLocaleLowerCase();
  const title = filter.title?.toLocaleLowerCase();
  return (!app || window2.app.toLocaleLowerCase().includes(app)) && (!title || window2.title.toLocaleLowerCase().includes(title));
}
function guardRun(context, method) {
  if (context.readOnly)
    throw new ToolError(`read-only run: '${method}' requires read_only: false`);
  throwIfAborted(context.signal);
}
async function captureScreenshot(session, getContext, target, options) {
  const context = getContext();
  const frame = await nativeCall(context.signal, () => session.capture(target, {
    maxWidth: context.snapshot.captureMaxWidth,
    maxHeight: context.snapshot.captureMaxHeight
  }));
  const destination = path6.join(os3.tmpdir(), `omp-computer-${Snowflake.next()}.png`);
  await Bun.write(destination, frame.data);
  const scaled = frame.width !== frame.sourceWidth || frame.height !== frame.sourceHeight;
  context.screenshots.push({
    path: destination,
    width: frame.width,
    height: frame.height,
    sourceWidth: frame.sourceWidth,
    sourceHeight: frame.sourceHeight,
    target: frame.target
  });
  if (!options?.silent) {
    context.output.push({
      type: "text",
      text: scaled ? `screenshot ${frame.target} ${frame.width}\xD7${frame.height} (scaled from ${frame.sourceWidth}\xD7${frame.sourceHeight}) \u2192 ${destination}` : `screenshot ${frame.target} ${frame.width}\xD7${frame.height} \u2192 ${destination}`
    });
    context.output.push({
      type: "image",
      data: Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength).toString("base64"),
      mimeType: "image/png"
    });
  }
  return { path: destination, width: frame.width, height: frame.height };
}

class El {
  ref;
  role;
  nativeRole;
  title;
  description;
  enabled;
  focused;
  childCount;
  #session;
  #getContext;
  constructor(session, getContext, node) {
    this.#session = session;
    this.#getContext = getContext;
    this.ref = node.ref;
    this.role = node.role;
    this.nativeRole = node.nativeRole;
    this.title = node.title;
    this.description = node.description;
    this.enabled = node.enabled;
    this.focused = node.focused;
    this.childCount = node.childCount;
  }
  async value() {
    const { signal } = this.#getContext();
    return (await nativeCall(signal, () => this.#session.axNode(this.ref))).value;
  }
  async setValue(value) {
    const context = this.#getContext();
    guardRun(context, "setValue");
    await nativeCall(context.signal, () => this.#session.axSetValue(this.ref, value));
  }
  async bounds() {
    const { signal } = this.#getContext();
    const node = await nativeCall(signal, () => this.#session.axNode(this.ref));
    if (node.x === undefined || node.y === undefined || node.width === undefined || node.height === undefined)
      return null;
    return { x: node.x, y: node.y, width: node.width, height: node.height };
  }
  async attributes() {
    const { signal } = this.#getContext();
    return Object.fromEntries(await nativeCall(signal, () => this.#session.axAttributes(this.ref)));
  }
  async actions() {
    const { signal } = this.#getContext();
    return (await nativeCall(signal, () => this.#session.axNode(this.ref))).actions ?? [];
  }
  async perform(action) {
    const context = this.#getContext();
    guardRun(context, "perform");
    await nativeCall(context.signal, () => this.#session.axPerform(this.ref, action));
  }
  async press() {
    const context = this.#getContext();
    guardRun(context, "press");
    await nativeCall(context.signal, () => this.#session.axPerform(this.ref, "press"));
  }
  async click(options) {
    const context = this.#getContext();
    guardRun(context, "click");
    await nativeCall(context.signal, () => this.#session.axClick(this.ref, pointerOptions(options)));
  }
  async focus() {
    const context = this.#getContext();
    guardRun(context, "focus");
    await nativeCall(context.signal, () => this.#session.axFocus(this.ref));
  }
  async parent() {
    const { signal } = this.#getContext();
    const node = await nativeCall(signal, () => this.#session.axParent(this.ref));
    return node ? new El(this.#session, this.#getContext, node) : null;
  }
  async children() {
    const { signal } = this.#getContext();
    return (await nativeCall(signal, () => this.#session.axChildren(this.ref))).map((node) => new El(this.#session, this.#getContext, node));
  }
}

class Win {
  id;
  app;
  title;
  pid;
  bounds;
  focused;
  #session;
  #getContext;
  constructor(session, getContext, window2) {
    this.#session = session;
    this.#getContext = getContext;
    this.id = window2.id;
    this.app = window2.app;
    this.title = window2.title;
    this.pid = window2.pid;
    this.bounds = { x: window2.x, y: window2.y, width: window2.width, height: window2.height };
    this.focused = window2.focused;
  }
  screenshot(options) {
    return captureScreenshot(this.#session, this.#getContext, this.id, options);
  }
  async click(x, y, options) {
    const context = this.#getContext();
    guardRun(context, "click");
    await nativeCall(context.signal, () => this.#session.click(this.id, x, y, pointerOptions(options)));
  }
  async doubleClick(x, y, options) {
    const context = this.#getContext();
    guardRun(context, "doubleClick");
    await nativeCall(context.signal, () => this.#session.click(this.id, x, y, pointerOptions({ ...options, count: 2 })));
  }
  async move(x, y) {
    const context = this.#getContext();
    guardRun(context, "move");
    await nativeCall(context.signal, () => this.#session.moveMouse(this.id, x, y));
  }
  async drag(points, options) {
    const context = this.#getContext();
    guardRun(context, "drag");
    await nativeCall(context.signal, () => this.#session.drag(this.id, points.map(([x, y]) => ({ x, y })), pointerOptions(options)));
  }
  async scroll(x, y, options = {}) {
    const context = this.#getContext();
    guardRun(context, "scroll");
    await nativeCall(context.signal, () => this.#session.scroll(this.id, x, y, options.dx ?? 0, options.dy ?? 0, pointerOptions(options)));
  }
  async type(text, options) {
    const context = this.#getContext();
    guardRun(context, "type");
    await nativeCall(context.signal, () => this.#session.typeText(this.id, text, pointerOptions(options)));
  }
  async press(chord, options) {
    const context = this.#getContext();
    guardRun(context, "press");
    await nativeCall(context.signal, () => this.#session.keyChord(this.id, chordKeys(chord), pointerOptions(options)));
  }
  async raise() {
    const context = this.#getContext();
    guardRun(context, "raise");
    await nativeCall(context.signal, () => this.#session.raiseWindow(this.id));
  }
  async ax(options) {
    const { signal } = this.#getContext();
    return (await nativeCall(signal, () => this.#session.axSnapshot(this.id, options))).text;
  }
  async find(query) {
    const { signal } = this.#getContext();
    const nodes = await nativeCall(signal, () => this.#session.axQuery(this.id, { ...query, limit: 1 }));
    const node = nodes[0];
    return node ? new El(this.#session, this.#getContext, node) : null;
  }
  async findAll(query) {
    const { signal } = this.#getContext();
    return (await nativeCall(signal, () => this.#session.axQuery(this.id, query))).map((node) => new El(this.#session, this.#getContext, node));
  }
  async ref(ref) {
    const { signal } = this.#getContext();
    return new El(this.#session, this.#getContext, await nativeCall(signal, () => this.#session.axNode(ref)));
  }
}

class ComputerWorkerCore {
  #transport;
  #createSession;
  #unsubscribe;
  #session;
  #runtime;
  #active = null;
  #runContexts = new AsyncLocalStorage3;
  #closed = false;
  constructor(transport, createSession = createDesktopSession) {
    this.#transport = transport;
    this.#createSession = createSession;
    this.#unsubscribe = transport.onMessage((message) => this.handle(message));
    this.#transport.send({ type: "ready" });
  }
  handle(message) {
    switch (message.type) {
      case "ping":
        this.#transport.send({ type: "pong", id: message.id });
        return;
      case "run":
        this.#run(message);
        return;
      case "abort":
        if (this.#active?.id === message.id)
          this.#active.ac.abort(new ToolAbortError);
        return;
      case "tool-reply":
        this.#deliverToolReply(message.id, message.reply);
        return;
      case "close":
        this.#close();
    }
  }
  #ensureSession(snapshot) {
    if (this.#session)
      return this.#session;
    try {
      this.#session = this.#createSession({ display: snapshot.display });
      return this.#session;
    } catch (error2) {
      throw nativeError(error2);
    }
  }
  #ensureRuntime(snapshot) {
    if (this.#runtime)
      return this.#runtime;
    this.#runtime = new JsRuntime({ initialCwd: snapshot.cwd, sessionId: snapshot.sessionId });
    return this.#runtime;
  }
  async#run(message) {
    if (this.#closed) {
      this.#transport.send({
        type: "result",
        id: message.id,
        ok: false,
        error: errorPayload(new ToolError("Computer worker is closed"))
      });
      return;
    }
    if (this.#active) {
      this.#transport.send({
        type: "result",
        id: message.id,
        ok: false,
        error: errorPayload(new ToolError("Computer worker is busy"))
      });
      return;
    }
    const timeoutSignal = AbortSignal.timeout(message.timeoutMs);
    const ac = new AbortController;
    const runAc = new AbortController;
    const signal = AbortSignal.any([timeoutSignal, ac.signal, runAc.signal]);
    const active = { id: message.id, ac, signal, pendingTools: new Map };
    this.#active = active;
    const output = new RunOutput;
    const screenshots = [];
    const runContext = {
      signal,
      readOnly: message.session.readOnly,
      snapshot: message.session,
      output,
      screenshots
    };
    let returnValue;
    let failure;
    let completed = false;
    try {
      throwIfAborted(signal);
      const session = this.#ensureSession(message.session);
      const runtime = this.#ensureRuntime(message.session);
      runtime.setCwd(message.session.cwd);
      const desktop = this.#createDesktopScope(session);
      runtime.setRunScope({
        desktop: bindRunFacade(desktop, signal),
        assert: (condition, text) => {
          if (!condition)
            throw new ToolError(text ?? "Assertion failed");
        },
        wait: (msOrPredicate, options) => {
          const resolved = typeof msOrPredicate === "number" ? undefined : {
            timeout: resolvePredicateTimeout(message.timeoutMs, options?.timeout),
            interval: options?.interval
          };
          return markHandled(waitForRun(msOrPredicate, signal, resolved));
        }
      });
      const { promise: cancelRejection, reject: rejectCancel } = Promise.withResolvers();
      const onCancel = () => {
        const abortError = signal.reason instanceof ToolAbortError ? signal.reason : new ToolAbortError(undefined, { cause: signal.reason });
        rejectCancel(timeoutSignal.aborted ? new ToolError(`Computer code execution timed out after ${message.timeoutMs}ms`) : abortError);
        const toolAbort = timeoutSignal.aborted ? markExpectedCleanupError(new ToolAbortError(undefined, { cause: timeoutSignal.reason })) : abortError;
        for (const pending of active.pendingTools.values())
          pending.reject(toolAbort);
        active.pendingTools.clear();
      };
      if (signal.aborted)
        onCancel();
      else
        signal.addEventListener("abort", onCancel, { once: true });
      try {
        returnValue = await Promise.race([
          this.#runContexts.run(runContext, () => runtime.run(message.code, `computer-run-${message.id}.js`, this.#runtimeHooks(active, output), {
            runId: message.id,
            cwd: message.session.cwd
          })),
          cancelRejection
        ]);
        completed = true;
      } finally {
        signal.removeEventListener("abort", onCancel);
      }
    } catch (error2) {
      failure = { error: error2 };
    } finally {
      runAc.abort(markExpectedCleanupError(new ToolAbortError("Computer run ended")));
      if (this.#active?.id === message.id)
        this.#active = null;
    }
    if (failure !== undefined) {
      this.#transport.send({ type: "result", id: message.id, ok: false, error: errorPayload(failure.error) });
      return;
    }
    if (completed) {
      let capabilities;
      try {
        capabilities = this.#ensureSession(message.session).capabilities;
      } catch (error2) {
        this.#transport.send({
          type: "result",
          id: message.id,
          ok: false,
          error: errorPayload(nativeError(error2))
        });
        return;
      }
      this.#transport.send({
        type: "result",
        id: message.id,
        ok: true,
        payload: { displays: output.finish(), returnValue: cloneSafe(returnValue), screenshots, capabilities }
      });
    }
  }
  #runtimeHooks(active, output) {
    return {
      onText: (chunk) => {
        throwIfAborted(active.signal);
        output.pushText(chunk);
      },
      onDisplay: (display) => {
        throwIfAborted(active.signal);
        output.pushDisplay(display);
      },
      callTool: (name, args) => {
        throwIfAborted(active.signal);
        return this.#callTool(active, name, args);
      }
    };
  }
  async#callTool(active, name, args) {
    const id = `computer-tc-${active.id}-${crypto.randomUUID()}`;
    const { promise, resolve: resolve3, reject } = Promise.withResolvers();
    active.pendingTools.set(id, { resolve: resolve3, reject });
    this.#transport.send({ type: "tool-call", id, runId: active.id, name, args });
    return await promise;
  }
  #deliverToolReply(id, reply) {
    const pending = this.#active?.pendingTools.get(id);
    if (!pending)
      return;
    this.#active?.pendingTools.delete(id);
    if (reply.ok)
      pending.resolve(reply.value);
    else
      pending.reject(replyError(reply.error));
  }
  #currentRunContext = () => {
    const context = this.#runContexts.getStore();
    if (!context)
      throw new ToolError("no active computer run");
    return context;
  };
  #createDesktopScope(session) {
    const getContext = this.#currentRunContext;
    const makeWin = (window2) => new Win(session, getContext, window2);
    const el = (node) => new El(session, getContext, node);
    const desktopTarget = new Win(session, getContext, {
      id: "desktop",
      app: "desktop",
      title: "desktop",
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      focused: false
    });
    return {
      capabilities: () => {
        const { signal } = getContext();
        throwIfAborted(signal);
        try {
          return session.capabilities;
        } catch (error2) {
          throw nativeError(error2);
        }
      },
      displays: async () => {
        const { signal } = getContext();
        return await nativeCall(signal, () => session.listDisplays());
      },
      windows: async (filter) => {
        const { signal } = getContext();
        return (await nativeCall(signal, () => session.listWindows())).filter((window2) => matchesFilter(window2, filter));
      },
      window: async (selector) => {
        const { signal } = getContext();
        const windows = await nativeCall(signal, () => session.listWindows());
        const matches = typeof selector === "string" ? windows.filter((window2) => window2.id === selector) : windows.filter((window2) => matchesFilter(window2, selector));
        if (matches.length === 0)
          throw new ToolError(`no window matches ${JSON.stringify(selector)}`);
        if (matches.length > 1) {
          const candidates = matches.map((window2) => `${window2.id} ${window2.app} ${JSON.stringify(window2.title)}`).join(`
`);
          throw new ToolError(`multiple windows match ${JSON.stringify(selector)}:
${candidates}`);
        }
        return makeWin(matches[0]);
      },
      focusedWindow: async () => {
        const { signal } = getContext();
        const window2 = (await nativeCall(signal, () => session.listWindows())).find((candidate) => candidate.focused);
        return window2 ? makeWin(window2) : null;
      },
      screenshot: (options) => captureScreenshot(session, getContext, "desktop", options),
      click: desktopTarget.click.bind(desktopTarget),
      doubleClick: desktopTarget.doubleClick.bind(desktopTarget),
      move: desktopTarget.move.bind(desktopTarget),
      drag: desktopTarget.drag.bind(desktopTarget),
      scroll: desktopTarget.scroll.bind(desktopTarget),
      type: desktopTarget.type.bind(desktopTarget),
      press: desktopTarget.press.bind(desktopTarget),
      elementAt: async (x, y) => {
        const { signal } = getContext();
        const node = await nativeCall(signal, () => session.axElementAt("desktop", x, y));
        return node ? el(node) : null;
      },
      focusedElement: async () => {
        const { signal } = getContext();
        const node = await nativeCall(signal, () => session.axFocused());
        return node ? el(node) : null;
      },
      clipboard: {
        read: async () => {
          const { signal } = getContext();
          throwIfAborted(signal);
          const text = await readTextFromClipboard();
          throwIfAborted(signal);
          return text;
        },
        write: async (text) => {
          const context = getContext();
          guardRun(context, "clipboard.write");
          await copyToClipboard(text);
          throwIfAborted(context.signal);
        }
      }
    };
  }
  async#close() {
    if (this.#closed)
      return;
    this.#closed = true;
    this.#active?.ac.abort(new ToolAbortError);
    try {
      await this.#session?.close();
    } catch {} finally {
      this.#session = undefined;
      this.#unsubscribe();
      this.#transport.send({ type: "closed" });
      this.#transport.close();
    }
  }
}
var init_worker = __esm(() => {
  init_postmortem();
  init_snowflake();
  init_runtime();
  init_clipboard();
  init_run_scope();
  init_tool_errors();
});

// src/tools/computer/worker-entry.ts
var exports_worker_entry = {};
__export(exports_worker_entry, {
  startComputerWorker: () => startComputerWorker
});
import { parentPort } from "worker_threads";
function startComputerWorker() {
  if (started || !parentPort)
    return;
  started = true;
  const port = parentPort;
  const inbox = consumeWorkerInbox();
  const transport = {
    send(message, transfer) {
      port.postMessage(message, transfer ?? []);
    },
    onMessage(handler) {
      if (inbox)
        return inbox.bind((message) => handler(message));
      const listener = (message) => handler(message);
      port.on("message", listener);
      return () => port.off("message", listener);
    },
    close() {
      port.close();
    }
  };
  new ComputerWorkerCore(transport);
}
var started = false;
var init_worker_entry = __esm(() => {
  init_worker_host();
  init_worker();
  if (!Bun.argv.includes(COMPUTER_WORKER_ARG)) {
    startComputerWorker();
  }
});

// test/fixtures/computer-worker-bundled-host.ts
init_worker_host();
import { parentPort as parentPort2 } from "worker_threads";
if (process.argv[2] !== COMPUTER_WORKER_ARG)
  throw new Error(`unknown worker selector: ${process.argv[2]}`);
if (!parentPort2)
  throw new Error("computer worker fixture: missing parentPort");
installWorkerInbox(parentPort2);
await Promise.resolve().then(() => (init_worker_entry(), exports_worker_entry));
