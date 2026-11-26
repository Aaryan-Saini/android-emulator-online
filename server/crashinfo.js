// Explains an emulator crash: reads the Windows crash record and, when Windows kept one, the crash dump.
// A dump says where the crash happened and which libraries were on the crashing thread's stack, so it is
// clear whether the graphics renderer, the network code or something else brought the phone down.
const fs = require('fs');
const path = require('path');
const { run } = require('./util');

const CODES = { 0xc0000005: 'access violation', 0xc0000409: 'stack buffer overrun', 0xc00000fd: 'stack overflow', 0x80000003: 'breakpoint', 0xc000001d: 'illegal instruction' };

const hex = (n) => '0x' + n.toString(16);
const short = (name) => name.split(/[\\/]/).slice(-2).join('/'); // "gles_swiftshader/libGLESv2.dll"

// Minimal reader for the minidump format (threads, modules, memory, exception, thread names).
function readMinidump(file) {
  const b = fs.readFileSync(file);
  if (b.toString('latin1', 0, 4) !== 'MDMP') throw new Error('not a minidump');
  const u64 = (o) => Number(b.readBigUInt64LE(o));
  const str = (rva) => b.toString('utf16le', rva + 4, rva + 4 + b.readUInt32LE(rva));
  const streams = {};
  for (let i = 0, n = b.readUInt32LE(8), dir = b.readUInt32LE(12); i < n; i++) {
    const o = dir + i * 12;
    streams[b.readUInt32LE(o)] = { size: b.readUInt32LE(o + 4), rva: b.readUInt32LE(o + 8) };
  }
  const modules = [];
  if (streams[4]) {
    const r = streams[4].rva;
    for (let i = 0, n = b.readUInt32LE(r); i < n; i++) {
      const o = r + 4 + i * 108;
      modules.push({ base: u64(o), size: b.readUInt32LE(o + 8), name: str(b.readUInt32LE(o + 20)) });
    }
  }
  const memory = [];
  if (streams[5]) {
    const r = streams[5].rva;
    for (let i = 0, n = b.readUInt32LE(r); i < n; i++) {
      const o = r + 4 + i * 16;
      memory.push({ start: u64(o), size: b.readUInt32LE(o + 8), rva: b.readUInt32LE(o + 12) });
    }
  }
  if (streams[9]) {
    const r = streams[9].rva;
    let rva = u64(r + 8);
    for (let i = 0, n = u64(r); i < n; i++) {
      const o = r + 16 + i * 16;
      memory.push({ start: u64(o), size: u64(o + 8), rva });
      rva += u64(o + 8);
    }
  }
  const names = {};
  if (streams[24]) {
    const r = streams[24].rva;
    for (let i = 0, n = b.readUInt32LE(r); i < n; i++) {
      const o = r + 4 + i * 12;
      names[b.readUInt32LE(o)] = str(u64(o + 4));
    }
  }
  const threads = {};
  if (streams[3]) {
    const r = streams[3].rva;
    for (let i = 0, n = b.readUInt32LE(r); i < n; i++) {
      const o = r + 4 + i * 48;
      threads[b.readUInt32LE(o)] = { stackStart: u64(o + 24), stackSize: b.readUInt32LE(o + 32), stackRva: b.readUInt32LE(o + 36), ctxRva: b.readUInt32LE(o + 44) };
    }
  }
  let exception = null;
  if (streams[6]) {
    const r = streams[6].rva;
    exception = { threadId: b.readUInt32LE(r), code: b.readUInt32LE(r + 8), address: u64(r + 24), params: b.readUInt32LE(r + 32), info: [u64(r + 40), u64(r + 48)], ctxRva: b.readUInt32LE(r + 164) };
  }
  return { b, u64, modules, memory, names, threads, exception };
}

function analyzeDump(file) {
  const d = readMinidump(file);
  const ex = d.exception;
  if (!ex) return { file, summary: 'the dump has no crash record' };
  const moduleAt = (a) => d.modules.find((m) => a >= m.base && a < m.base + m.size);
  const where = (a) => {
    const m = moduleAt(a);
    return m ? `${short(m.name)}+${hex(a - m.base)}` : null;
  };
  const rsp = ex.ctxRva ? d.u64(ex.ctxRva + 0x98) : 0;
  const rip = ex.ctxRva ? d.u64(ex.ctxRva + 0xf8) : ex.address;
  // Return addresses on the crashing thread's stack: a scan, so it can include a few stale values, but the
  // libraries that show up are the ones that were running.
  const stack = [];
  const t = d.threads[ex.threadId];
  if (t && t.stackRva) {
    const from = Math.max(0, rsp - t.stackStart);
    for (let off = from - (from % 8); off + 8 <= t.stackSize && stack.length < 16; off += 8) {
      const v = d.u64(t.stackRva + off);
      const w = where(v);
      if (w && stack[stack.length - 1] !== w) stack.push(w);
    }
  }
  const libs = [...new Set(stack.map((s) => s.split('+')[0]))];
  const access = ex.code === 0xc0000005 && ex.params >= 2 ? ` (${['reading', 'writing', '', '', '', '', '', '', 'running code at'][ex.info[0]] || 'touching'} ${hex(ex.info[1])})` : '';
  const at = where(rip) || 'code that is in no library: generated while running, e.g. by the software graphics renderer';
  const thread = d.names[ex.threadId] ? ` on thread "${d.names[ex.threadId]}"` : '';
  return {
    file,
    code: hex(ex.code),
    what: CODES[ex.code] || 'crash',
    address: hex(rip),
    at,
    thread: d.names[ex.threadId] || null,
    stack,
    libraries: libs,
    summary: `${CODES[ex.code] || 'crash ' + hex(ex.code)}${access} at ${hex(rip)} in ${at}${thread}; libraries on the stack: ${libs.join(', ') || 'none found'}`,
  };
}

// The Windows "Application Error" record for a crashed process (written the moment it crashes).
async function windowsRecord(pid, minutes = 10) {
  if (process.platform !== 'win32' || !pid) return null;
  const ps = `Get-WinEvent -FilterHashtable @{LogName='Application'; Id=1000; StartTime=(Get-Date).AddMinutes(-${Number(minutes)})} -ErrorAction SilentlyContinue | Where-Object { $_.Message -match 'Faulting process id: 0x0*${pid.toString(16)}\\b' } | Select-Object -First 1 -ExpandProperty Message`;
  const { stdout } = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 30000 }).catch(() => ({ stdout: '' }));
  if (!stdout.trim()) return null;
  const get = (label) => ((stdout.match(new RegExp(`${label}:\\s*(.+)`)) || [])[1] || '').trim();
  const code = parseInt(get('Exception code'), 16);
  return { module: get('Faulting module name').split(',')[0], code: get('Exception code'), what: CODES[code] || 'crash', offset: get('Fault offset') };
}

module.exports = { analyzeDump, windowsRecord, short };

if (require.main === module) {
  const cfg = require('./config');
  const dir = path.join(cfg.DATA, 'crash-dumps');
  let file = process.argv[2];
  if (!file) {
    const dumps = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.dmp')).map((f) => path.join(dir, f)) : [];
    file = dumps.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  }
  if (!file) {
    console.log(`No crash dumps in ${dir}`);
    process.exit(0);
  }
  const r = analyzeDump(file);
  console.log(`${path.basename(file)}\n${r.summary}\n${r.stack ? 'stack:\n  ' + r.stack.join('\n  ') : ''}`);
}
