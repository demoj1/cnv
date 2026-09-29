#!/usr/bin/env node
// Страховка от кейса, на котором обжёгся друг: нативный pty.node, слинкованный против
// свежей glibc, падает на любой системе постарее («GLIBC_2.42 not found», замаскированное
// под «Cannot find module»). Здесь мы вскрываем ВСЕ .node в собранном приложении и валимся,
// если хоть один требует glibc выше потолка. Вызывается в CI после сборки — и локально.
import { execSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const TARGET = process.env.CNV_GLIBC_TARGET || '2.28'
const root = process.argv[2] || 'release/linux-unpacked'

const parse = (v) => v.split('.').map(Number)
const gt = (a, b) => {
  const [x, y] = parse(a)
  const [p, q] = parse(b)
  return x > p || (x === p && y > q)
}

function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    const full = path.join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else if (name.endsWith('.node')) out.push(full)
  }
  return out
}

// Только нативные модули под текущую платформу: чужие prebuilds (win/mac) не грузятся тут.
const mods = walk(root).filter((f) => !/(win32|darwin)/.test(f))
if (mods.length === 0) {
  console.error(`не нашёл ни одного .node в ${root} — сборки нет?`)
  process.exit(1)
}

let bad = false
for (const mod of mods) {
  let dump
  try {
    dump = execSync(`objdump -T "${mod}" 2>/dev/null || readelf -V "${mod}" 2>/dev/null`, {
      encoding: 'utf8'
    })
  } catch {
    console.error(`не смог прочитать символы ${mod}`)
    process.exit(1)
  }
  const versions = [...dump.matchAll(/GLIBC_([0-9]+\.[0-9]+(?:\.[0-9]+)?)/g)].map((m) => m[1])
  const max = versions.reduce((a, b) => (gt(b, a) ? b : a), '0.0')
  const over = versions.filter((v) => gt(v, TARGET))
  const rel = path.relative(root, mod)
  if (over.length) {
    bad = true
    console.error(`✗ ${rel}: требует GLIBC_${max} > ${TARGET} — не заведётся на старых системах`)
  } else {
    console.log(`✓ ${rel}: потолок GLIBC_${max} ≤ ${TARGET}`)
  }
}

if (bad) {
  console.error(`\nСборка непереносима. Пересобери нативные модули под старую glibc: npm run rebuild:native`)
  process.exit(1)
}
console.log(`\nвсе нативные модули укладываются в GLIBC_${TARGET}`)
