const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const run = promisify(execFile);
const fs = require("node:fs");

test("native listener parser uses the exact IPv4-reachable port and refuses ambiguous or malformed ownership", { skip: process.platform !== "win32" }, async () => {
  const file = path.resolve(__dirname, "../../../infra/scripts/control-dev-service.ps1").replaceAll("'", "''");
  // Parse only our local function, without executing any service actions.
  const script = `$tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile('${file}',[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Invalid manager syntax'}
$fn=$ast.FindAll({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Find-CoreListenerProcessId'},$true)[0]
. ([scriptblock]::Create($fn.Extent.Text))
$r=[ordered]@{
 exact=Find-CoreListenerProcessId -Port 3100 -Lines @(' TCP 127.0.0.1:3100 0.0.0.0:0 LISTENING 4321',' TCP 127.0.0.1:13100 0.0.0.0:0 LISTENING 9999')
 duplicate=Find-CoreListenerProcessId -Port 3100 -Lines @(' TCP 0.0.0.0:3100 0.0.0.0:0 LISTENING 4321',' TCP [::]:3100 [::]:0 LISTENING 4321')
 ambiguous=Find-CoreListenerProcessId -Port 3100 -Lines @(' TCP 127.0.0.1:3100 0.0.0.0:0 LISTENING 4321',' TCP [::]:3100 [::]:0 LISTENING 9876')
 ignored=Find-CoreListenerProcessId -Port 3100 -Lines @(' TCP [::1]:3100 [::]:0 LISTENING 9876',' TCP 127.0.0.1:3100 0.0.0.0:0 ESTABLISHED 1234',' TCP 127.0.0.1:3100 0.0.0.0:0 LISTENING 999999999999')
}
$r|ConvertTo-Json -Compress`;
  const result = await run("powershell.exe", ["-NoProfile", "-Command", script], { windowsHide: true, timeout: 20000 });
  assert.deepEqual(JSON.parse(result.stdout), { exact: 4321, duplicate: 4321, ambiguous: null, ignored: null });
});

test("ancestry uses one snapshot and refuses missing parents and cycles", { skip: process.platform !== "win32" }, async () => {
  const file = path.resolve(__dirname, "../../../infra/scripts/control-dev-service.ps1").replaceAll("'", "''");
  const script = `$tokens=$null;$errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile('${file}',[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Invalid manager syntax'}
$fn=$ast.FindAll({param($n)$n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Test-DescendantProcess'},$true)[0]
. ([scriptblock]::Create($fn.Extent.Text))
$script:calls=0
function Get-CimInstance { param($ClassName,$Property,$ErrorAction)
 $script:calls++
 foreach($pair in @(@(10,20),@(20,30),@(30,0),@(40,60),@(70,80),@(80,70))){[pscustomobject]@{ProcessId=$pair[0];ParentProcessId=$pair[1]}}
}
$valid=Test-DescendantProcess -ProcessId 10 -AncestorId 30
$calls=$script:calls
$r=[ordered]@{valid=$valid;queries=$calls;missing=(Test-DescendantProcess -ProcessId 40 -AncestorId 30);cycle=(Test-DescendantProcess -ProcessId 70 -AncestorId 30);invalid=(Test-DescendantProcess -ProcessId 0 -AncestorId 30)}
$r|ConvertTo-Json -Compress`;
  const result = await run("powershell.exe", ["-NoProfile", "-Command", script], { windowsHide: true, timeout: 20000 });
  assert.deepEqual(JSON.parse(result.stdout), { valid: true, queries: 1, missing: false, cycle: false, invalid: false });
});

test("desktop launch uses a hidden direct GUI process and clears Node-only mode only in the child", { skip: process.platform !== "win32" }, async () => {
  const file = path.resolve(__dirname, "../../../infra/scripts/start-control-center.ps1").replaceAll("'", "''");
  const script = `$tokens=$null;$errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile('${file}',[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Invalid launcher syntax'}
$fn=$ast.FindAll({param($n)$n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'New-CoreElectronStartInfo'},$true)[0]
. ([scriptblock]::Create($fn.Extent.Text))
$env:ELECTRON_RUN_AS_NODE='1';$env:CORE_FIXTURE_LAUNCH_ENV='keep'
$info=New-CoreElectronStartInfo -Executable 'C:\\fixture\\electron.exe' -WorkingDirectory 'C:\\fixture\\app'
[ordered]@{file=$info.FileName;arguments=$info.Arguments;directory=$info.WorkingDirectory;shell=$info.UseShellExecute;noConsole=$info.CreateNoWindow;windowStyle=[string]$info.WindowStyle;childNodeMode=$info.EnvironmentVariables.ContainsKey('ELECTRON_RUN_AS_NODE');parentUnchanged=($env:ELECTRON_RUN_AS_NODE -eq '1');ordinaryEnvironment=$info.EnvironmentVariables['CORE_FIXTURE_LAUNCH_ENV']}|ConvertTo-Json -Compress`;
  const result = await run("powershell.exe", ["-NoProfile", "-Command", script], { windowsHide: true, timeout: 20000 });
  assert.deepEqual(JSON.parse(result.stdout), { file: "C:\\fixture\\electron.exe", arguments: ".", directory: "C:\\fixture\\app", shell: false, noConsole: true, windowStyle: "Hidden", childNodeMode: false, parentUnchanged: true, ordinaryEnvironment: "keep" });
});

test("desktop launcher keeps compile/error handling and a bounded window wait without persistent cmd/Node wrappers", () => {
  const file = fs.readFileSync(path.resolve(__dirname, "../../../infra/scripts/start-control-center.ps1"), "utf8");
  assert.ok(file.startsWith("\ufeff"), "Windows PowerShell 5 must read existing Russian diagnostics as UTF-8");
  assert.ok(file.includes('node_modules\\electron\\dist\\electron.exe'));
  assert.equal(file.includes('node_modules\\.bin\\electron.cmd'), false);
  assert.ok(file.includes('$needsBuild') && file.includes('$LASTEXITCODE -ne 0'));
  assert.ok(file.includes('AddSeconds(30)') && file.includes('$process.Dispose()'));
  assert.ok(file.includes('$process.ExitCode -ne 0') && file.includes('MessageBox'));
  assert.equal(/Stop-Process|\.Kill\(/.test(file), false, "A timeout must never kill an unconfirmed process");
});
