// Compila native/WinOcr.cs → build/winocr.exe (ponte para o OCR do Windows) com o compilador C# que vem no
// .NET Framework 4 do próprio Windows — não precisa instalar nada. Só recompila se o código mudou.
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'native', 'WinOcr.cs');
const OUT = path.join(ROOT, 'build', 'winocr.exe');
const WIN = process.env.SystemRoot || 'C:\\Windows';
const FW = path.join(WIN, 'Microsoft.NET', 'Framework64', 'v4.0.30319');
const GAC = path.join(WIN, 'Microsoft.NET', 'assembly', 'GAC_MSIL');
const META = path.join(WIN, 'System32', 'WinMetadata');

if (fs.existsSync(OUT) && fs.statSync(OUT).mtimeMs >= fs.statSync(SRC).mtimeMs && !process.argv.includes('--force')) {
  console.log('winocr.exe em dia');
  process.exit(0);
}

// fachadas do .NET (System.Runtime…) que os metadados do Windows (.winmd) referenciam
const facade = (name) => {
  const dir = path.join(GAC, name);
  const ver = fs.readdirSync(dir).sort().pop();
  return path.join(dir, ver, name + '.dll');
};
const refs = [
  path.join(FW, 'System.Runtime.WindowsRuntime.dll'), // projeção de Windows.Foundation.Rect
  facade('System.Runtime'),
  facade('System.Threading.Tasks'),
  facade('System.Runtime.InteropServices.WindowsRuntime'),
  ...['Foundation', 'Globalization', 'Graphics', 'Media', 'Storage', 'Security'].map((n) => path.join(META, `Windows.${n}.winmd`)),
];
fs.mkdirSync(path.dirname(OUT), { recursive: true });
execFileSync(path.join(FW, 'csc.exe'), [
  '-nologo', '-optimize+', '-target:exe', '-platform:anycpu', '-codepage:65001',
  '-out:' + OUT, ...refs.map((r) => '-r:' + r), SRC,
], { stdio: 'inherit' });
console.log('winocr.exe compilado:', fs.statSync(OUT).size, 'bytes');
