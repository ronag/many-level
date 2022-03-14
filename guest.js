'use strict'

const duplexify = require('duplexify')
const { AbstractLevel, AbstractIterator } = require('abstract-level')
const eos = require('end-of-stream')
const lpstream = require('length-prefixed-stream')
const ModuleError = require('module-error')
const { input, output } = require('./tags')

const kExplicitClose = Symbol('explicitClose')
const kAbortRequests = Symbol('abortRequests')
const kEnded = Symbol('kEnded')
const kRemote = Symbol('remote')
const MAX_UINT = Math.pow(2, 32) - 1

class ManyLevelGuest extends AbstractLevel {
  constructor (options) {
    const { retry, _remote, ...forward } = options || {}

    super({
      encodings: { buffer: true },
      snapshots: !retry,
      permanence: true,
      seek: false,
      createIfMissing: false,
      errorIfExists: false
    }, forward)

    // TODO: use symbols
    this._iterators = new IdMap()
    this._requests = new IdMap()
    this._retry = !!retry
    this._encode = lpstream.encode()
    this[kRemote] = _remote || null
    this._streaming = null
    this._ref = null
    this._db = null
    this[kExplicitClose] = false
  }

  get type () {
    return 'many-level'
  }
}

exports.ManyLevelGuest = ManyLevelGuest

// TODO: move to class

ManyLevelGuest.prototype.createRpcStream = function (opts, proxy) {
  if (this._streaming) throw new Error('Only one rpc stream can be active')
  if (!opts) opts = {}
  this._ref = opts.ref || null

  const self = this
  const encode = this._encode
  const decode = lpstream.decode()

  decode.on('data', function (data) {
    if (!data.length) return

    const tag = data[0]
    const encoding = output.encoding(tag)

    if (!encoding) return

    let res
    try {
      res = encoding.decode(data, 1)
    } catch (err) {
      return
    }

    switch (tag) {
      case output.callback:
        oncallback(res)
        break

      case output.iteratorData:
        oniteratordata(res)
        break

      case output.getManyCallback:
        ongetmanycallback(res)
        break
    }

    self._flushMaybe()
  })

  // TODO: replace length-prefixed-stream with an already-duplex stream
  if (!proxy) proxy = duplexify()
  proxy.setWritable(decode)
  proxy.setReadable(encode)
  eos(proxy, cleanup)
  this._streaming = proxy
  return proxy

  function cleanup () {
    self._streaming = null
    self._encode = lpstream.encode()

    if (!self._retry) {
      self[kAbortRequests]('Connection to leader lost', 'LEVEL_CONNECTION_LOST')
      self._flushMaybe()
      return
    }

    for (const req of self._requests.values()) {
      self._write(req)
    }

    for (const ite of self._iterators.values()) {
      // TODO: it seems we don't clone the options anywhere. Also, why reset at all?
      // if (ite.options === ite.iterator._options) throw new Error('bug?')
      ite.options = ite.iterator._options
      self._write(ite)
    }
  }

  function oniteratordata (res) {
    const req = self._iterators.get(res.id)
    if (!req) return
    req.pending.push(res)
    if (req.callback) req.iterator._next(req.callback)
  }

  function oncallback (res) {
    const req = self._requests.remove(res.id)
    if (!req) return
    if (res.error) req.callback(new ModuleError('Could not get value', { code: res.error }))
    else req.callback(null, normalizeValue(res.value))
  }

  function ongetmanycallback (res) {
    const req = self._requests.remove(res.id)
    if (!req) return
    if (res.error) req.callback(new ModuleError('Could not get values', { code: res.error }))
    else req.callback(null, res.values.map(v => normalizeValue(v.value)))
  }
}

// Alias for backwards compat with multileveldown
ManyLevelGuest.prototype.connect = function (...args) {
  return this.createRpcStream(...args)
}

ManyLevelGuest.prototype.forward = function (db2) {
  // We forward calls to the private API of db2, so it must support 'buffer'
  for (const enc of ['keyEncoding', 'valueEncoding']) {
    if (db2[enc]('buffer').name !== 'buffer') {
      throw new ModuleError(`Database must support non-transcoded 'buffer' ${enc}`, {
        code: 'LEVEL_ENCODING_NOT_SUPPORTED'
      })
    }
  }

  this._db = db2
}

ManyLevelGuest.prototype.isFlushed = function () {
  return !this._requests.size && !this._iterators.size
}

// TODO: use symbols
ManyLevelGuest.prototype._flushMaybe = function () {
  if (!this.isFlushed()) return
  this.emit('flush')
  unref(this._ref)
}

ManyLevelGuest.prototype[kAbortRequests] = function (msg, code) {
  for (const req of this._requests.clear()) {
    req.callback(new ModuleError(msg, { code }))
  }

  for (const ite of this._iterators.clear()) {
    // Cancel in-flight operation if any
    const callback = ite.callback
    ite.callback = null

    if (callback) {
      callback(new ModuleError(msg, { code }))
    }

    // Note: an in-flight operation would block close()
    ite.iterator.close(noop)
  }
}

ManyLevelGuest.prototype._get = function (key, opts, cb) {
  // TODO: this and other methods assume _db state matches our state
  if (this._db) return this._db._get(key, opts, cb)

  const req = {
    tag: input.get,
    id: 0,
    key: key,
    callback: cb
  }

  req.id = this._requests.add(req)
  this._write(req)
}

ManyLevelGuest.prototype._getMany = function (keys, opts, cb) {
  if (this._db) return this._db._getMany(keys, opts, cb)

  const req = {
    tag: input.getMany,
    id: 0,
    keys: keys,
    callback: cb
  }

  req.id = this._requests.add(req)
  this._write(req)
}

ManyLevelGuest.prototype._put = function (key, value, opts, cb) {
  if (this._db) return this._db._put(key, value, opts, cb)

  const req = {
    tag: input.put,
    id: 0,
    key: key,
    value: value,
    callback: cb
  }

  req.id = this._requests.add(req)
  this._write(req)
}

ManyLevelGuest.prototype._del = function (key, opts, cb) {
  if (this._db) return this._db._del(key, opts, cb)

  const req = {
    tag: input.del,
    id: 0,
    key: key,
    callback: cb
  }

  req.id = this._requests.add(req)
  this._write(req)
}

ManyLevelGuest.prototype._batch = function (batch, opts, cb) {
  if (this._db) return this._db._batch(batch, opts, cb)

  const req = {
    tag: input.batch,
    id: 0,
    ops: batch,
    callback: cb
  }

  req.id = this._requests.add(req)
  this._write(req)
}

ManyLevelGuest.prototype._clear = function (opts, cb) {
  if (this._db) return this._db._clear(opts, cb)

  const req = {
    tag: input.clear,
    id: 0,
    options: opts,
    callback: cb || noop
  }

  req.id = this._requests.add(req)
  this._write(req)
}

ManyLevelGuest.prototype._write = function (req) {
  if (this._requests.size + this._iterators.size === 1) ref(this._ref)
  const enc = input.encoding(req.tag)
  const buf = Buffer.allocUnsafe(enc.encodingLength(req) + 1)
  buf[0] = req.tag
  enc.encode(req, buf, 1)
  this._encode.write(buf)
}

ManyLevelGuest.prototype._close = function (cb) {
  if (this._db) return this._db._close(cb)

  this[kExplicitClose] = true
  this[kAbortRequests]('Aborted on database close()', 'LEVEL_DATABASE_NOT_OPEN')

  if (this._streaming) {
    // _streaming could be a socket and emit 'close' with a
    // hadError argument. Ignore that argument.
    this._streaming.once('close', () => {
      this._streaming = null
      cb()
    })
    this._streaming.destroy()
  } else {
    this.nextTick(cb)
  }
}

ManyLevelGuest.prototype._open = function (options, cb) {
  if (this[kRemote]) {
    // For tests only so does not need error handling
    this[kExplicitClose] = false
    const remote = this[kRemote]()
    remote.pipe(this.connect()).pipe(remote)
  } else if (this[kExplicitClose]) {
    throw new ModuleError('Cannot reopen many-level database after close()', {
      code: 'LEVEL_NOT_SUPPORTED'
    })
  }

  this.nextTick(cb)
}

ManyLevelGuest.prototype._iterator = function (options) {
  if (this._db) {
    return this._db._iterator(options)
  }

  return new Iterator(this, options)
}

function noop () {}

// TODO: support seek
class Iterator extends AbstractIterator {
  constructor (db, options) {
    // Avoid spread operator because of https://bugs.chromium.org/p/chromium/issues/detail?id=1204540
    super(db, Object.assign({}, options, { abortOnClose: true }))

    this._options = options

    const req = {
      tag: input.iterator,
      id: 0,
      batch: 32,
      pending: [],
      iterator: this,
      options: options,
      callback: null
    }

    req.id = this.db._iterators.add(req)

    // TODO: use symbols
    this._read = 0
    this._ack = Math.floor(req.batch / 2)
    this._req = req
    this[kEnded] = false
    this.db._write(req)
  }
}

// TODO: move to class

// TODO: implement optimized `nextv()`
Iterator.prototype._next = function (callback) {
  if (this[kEnded]) {
    return this.nextTick(callback)
  }

  this._req.callback = null

  if (this._req.pending.length) {
    this._read++

    if (this._read >= this._ack) {
      this._read = 0
      this._req.options = null
      this.db._write(this._req)
    }

    const next = this._req.pending.shift()

    if (next.error) {
      return this.nextTick(callback, new ModuleError('Could not read entry', {
        code: next.error
      }))
    }

    if (!next.key && !next.value) {
      // https://github.com/Level/abstract-level/issues/19
      this[kEnded] = true
      return this.nextTick(callback)
    }

    this._options.gt = next.key
    this._options.gte = null
    if (this._options.limit > 0) this._options.limit--

    const key = normalizeValue(next.key)
    const val = normalizeValue(next.value)

    return this.nextTick(callback, undefined, key, val)
  }

  this._req.callback = callback
}

Iterator.prototype._close = function (cb) {
  this.db._write({ tag: input.iteratorClose, id: this._req.id })
  this.db._iterators.remove(this._req.id)
  this.db._flushMaybe()
  this.nextTick(cb)
}

function normalizeValue (value) {
  return value === null ? undefined : value
}

function ref (r) {
  if (r && r.ref) r.ref()
}

function unref (r) {
  if (r && r.unref) r.unref()
}

class IdMap {
  constructor () {
    this._map = new Map()
    this._seq = 0
  }

  get size () {
    return this._map.size
  }

  add (item) {
    if (this._seq >= MAX_UINT) this._seq = 0
    this._map.set(++this._seq, item)
    return this._seq
  }

  get (id) {
    return this._map.get(id)
  }

  remove (id) {
    const item = this._map.get(id)
    if (item !== undefined) this._map.delete(id)
    return item
  }

  values () {
    return this._map.values()
  }

  clear () {
    const values = Array.from(this._map.values())
    this._map.clear()
    this._seq = 0
    return values
  }
}
