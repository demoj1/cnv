#!/usr/bin/env node
// Пересобирает нативный node-pty под ABI Electron и — главное — против СТАРОЙ glibc.
//
// Иначе бинарь линкуется против glibc машины сборки (у меня CachyOS, glibc 2.44), и на
// любой другой системе падает «GLIBC_2.42 not found», причём node-pty маскирует это под
// «Cannot find module ./prebuilds/...». Zig умеет линковать под заданную версию glibc без
// контейнера — берём 2.28 (Debian 10 / Ubuntu 18.10), это покрывает всё живое.
//
// Вызывается из build:linux, так что о нём не надо помнить руками.
import { execFileSync } from 'node:child_process'

const GLIBC = process.env.CNV_GLIBC_TARGET || '2.28'
const target = `x86_64-linux-gnu.${GLIBC}`

function hasZig() {
  try {
    // Именно `zig version`: флага `--version` у zig нет.
    execFileSync('zig', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

if (!hasZig()) {
  console.error(
    'Нужен zig: node-pty иначе слинкуется против glibc этой машины и не запустится ни у кого.\n' +
      'Поставь zig (https://ziglang.org) или собери в контейнере с достаточно старой glibc.'
  )
  process.exit(1)
}

console.log(`node-pty → Electron ABI, glibc ${GLIBC} (через zig)`)
execFileSync('npx', ['electron-rebuild', '-f', '-w', 'node-pty'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    CC: `zig cc -target ${target}`,
    CXX: `zig c++ -target ${target}`
  }
})
