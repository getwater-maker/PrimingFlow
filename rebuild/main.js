const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  powerSaveBlocker
} = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const {
  execFile
} = require("child_process");
const {
  AuthManager
} = require("./auth-manager");
app.commandLine.appendSwitch("disable-gpu");
// 창이 최소화/가려져도 자동제작(렌더러 타이머 기반 루프)이 멈추지 않게 —
// 크로미움 백그라운드 스로틀링 전면 비활성 (webPreferences.backgroundThrottling 과 한 쌍).
// 증상: 자동제작 중 PrimingFlow 창을 안 띄워두면 Genspark 첫 배치 후 멈춤 → 창 띄우면 재개.
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
let mainWindow;
let automator = null;
const authManager = new AuthManager();
const SETTINGS_PATH = path.join(os.homedir(), ".flow-app", "settings.json");
function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
    } else {
      return {};
    }
  } catch {
    return {};
  }
}
function saveSettings(_0x4a36f6) {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), {
    recursive: true
  });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify({
    ...loadSettings(),
    ..._0x4a36f6
  }, null, 2), "utf-8");
}
function sanitizeError(_0x423ef5, _0xde2114 = "보정") {
  const _0x400307 = _0x423ef5 && (_0x423ef5.stack || _0x423ef5.message) || String(_0x423ef5);
  try {
    console.error("[내부오류:" + _0xde2114 + "]", _0x400307);
  } catch {}
  let _0xae50b4 = (_0x423ef5 && _0x423ef5.message || String(_0x423ef5)).replace(/\r?\n/g, " ").trim();
  _0xae50b4 = _0xae50b4.replace(/Command failed:\s*\S+(?:\s+\S+)*/gi, _0xde2114 + " 스크립트 실행 실패");
  _0xae50b4 = _0xae50b4.replace(/\b[Pp]ython(?:\.exe)?\b/g, "내부도구");
  _0xae50b4 = _0xae50b4.replace(/\S*_(?:vrew_repair|vrew_unzip|unzip|maker|repair)_\d+\.py\S*/g, "(임시)");
  _0xae50b4 = _0xae50b4.replace(/[A-Za-z]:\\[^\s"']*Temp\\\S*/gi, "(임시)");
  _0xae50b4 = _0xae50b4.replace(/\/tmp\/\S*/g, "(임시)");
  _0xae50b4 = _0xae50b4.replace(/\s{2,}/g, " ").replace(/\s*\(임시\)\s*/g, " ").trim();
  if (!_0xae50b4 || _0xae50b4.length < 4) {
    _0xae50b4 = _0xde2114 + " 실패 (세부내역은 개발자 콘솔 참고)";
  }
  return _0xae50b4;
}
function isChromiumInstalled() {
  try {
    const _0x3949ee = require("playwright");
    const _0x40c2f0 = _0x3949ee.chromium.executablePath();
    return fs.existsSync(_0x40c2f0);
  } catch {
    return false;
  }
}
function installChromium(_0x400073) {
  return new Promise((_0x4de653, _0x49389d) => {
    const _0x52b982 = path.join(require.resolve("playwright"), "..", "cli.js");
    if (_0x400073 && !_0x400073.isDestroyed()) {
      _0x400073.webContents.send("log", "[설치] Chromium 브라우저 다운로드 중... (최초 1회)");
    }
    const _0x432119 = execFile(process.execPath.includes("electron") ? process.argv[0] : process.execPath, [_0x52b982, "install", "chromium"], {
      env: {
        ...process.env
      },
      timeout: 300000
    }, (_0x2974a5, _0x30673d, _0x12f78a) => {
      if (_0x2974a5) {
        console.error("Chromium 설치 실패:", _0x12f78a || _0x2974a5.message);
        _0x49389d(_0x2974a5);
      } else {
        console.log("Chromium 설치 완료:", _0x30673d);
        _0x4de653();
      }
    });
    _0x432119.stdout?.on("data", _0x50d43f => {
      const _0x49d1c6 = _0x50d43f.toString().trim();
      if (_0x49d1c6 && _0x400073 && !_0x400073.isDestroyed()) {
        _0x400073.webContents.send("log", "[설치] " + _0x49d1c6);
      }
    });
  });
}
async function ensureChromium(_0xad5b4) {
  if (isChromiumInstalled()) {
    console.log("Chromium 이미 설치됨");
    return;
  }
  console.log("Chromium 설치 필요 — 자동 설치 시작");
  if (_0xad5b4 && !_0xad5b4.isDestroyed()) {
    _0xad5b4.webContents.send("log", "Chromium 브라우저 설치 중... (최초 1회)");
  }
  return new Promise((_0x3a7d4c, _0x4ac37a) => {
    const _0x148bb2 = path.join(require.resolve("playwright"), "..", "cli.js");
    const _0x5e7070 = process.execPath;
    const _0x1cfeb9 = {
      ...process.env
    };
    _0x1cfeb9.ELECTRON_RUN_AS_NODE = "1";
    const _0x2aba2d = {
      env: _0x1cfeb9,
      timeout: 300000
    };
    const _0x1c37a9 = execFile(_0x5e7070, [_0x148bb2, "install", "chromium"], _0x2aba2d, (_0x1559f9, _0x38456b, _0x4a3744) => {
      if (_0x1559f9) {
        console.error("Chromium 설치 실패:", _0x4a3744 || _0x1559f9.message);
        if (_0xad5b4 && !_0xad5b4.isDestroyed()) {
          _0xad5b4.webContents.send("log", "Chromium 자동 설치 실패. 터미널에서 \"npx playwright install chromium\" 실행해주세요.");
        }
        _0x4ac37a(_0x1559f9);
      } else {
        console.log("Chromium 설치 완료");
        if (_0xad5b4 && !_0xad5b4.isDestroyed()) {
          _0xad5b4.webContents.send("log", "Chromium 설치 완료!");
        }
        _0x3a7d4c();
      }
    });
    _0x1c37a9.stdout?.on("data", _0x3f7a26 => {
      const _0x64519e = _0x3f7a26.toString().trim();
      if (_0x64519e) {
        console.log("[설치]", _0x64519e);
      }
    });
    _0x1c37a9.stderr?.on("data", _0xcaf1be => {
      const _0x3768c9 = _0xcaf1be.toString().trim();
      if (_0x3768c9) {
        console.log("[설치]", _0x3768c9);
      }
    });
  });
}
app.whenReady().then(async () => {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 950,
    minWidth: 900,
    minHeight: 700,
    title: "Priming Flow",
    icon: path.join(__dirname, "icon", "flow.ico"),
    backgroundColor: "#0f0f1a",
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false
    }
  });
  mainWindow.loadFile("ui/index.html");
  mainWindow.setMenuBarVisibility(false);
  try {
    await ensureChromium(mainWindow);
  } catch (_0x280c29) {
    console.error("Chromium 자동 설치 실패:", _0x280c29.message);
  }
});
app.on("window-all-closed", () => app.quit());
ipcMain.handle("auth-check", async () => {
  try {
    const _0x502f10 = await authManager.authenticate();
    if (_0x502f10.access.app_status === "active") {
      const _0xc1e180 = {
        success: true,
        user: _0x502f10.user,
        access: _0x502f10.access
      };
      return _0xc1e180;
    }
    return {
      success: false,
      error: authManager.getStatusMessage(_0x502f10.access.app_status, _0x502f10.access)
    };
  } catch (_0x5c2fb5) {
    if (_0x5c2fb5.code === "UNAUTHORIZED" || _0x5c2fb5.code === "INVALID_TOKEN") {
      return {
        success: false,
        needLogin: true
      };
    }
    const _0x102ce6 = {
      success: false,
      error: _0x5c2fb5.userMessage || _0x5c2fb5.message
    };
    return _0x102ce6;
  }
});
ipcMain.handle("auth-login", async () => {
  try {
    const _0x5958af = await authManager.fullLogin(mainWindow);
    if (_0x5958af.access.app_status === "active") {
      const _0x525be4 = {
        success: true,
        user: _0x5958af.user,
        access: _0x5958af.access
      };
      return _0x525be4;
    }
    return {
      success: false,
      statusMessage: authManager.getStatusMessage(_0x5958af.access.app_status, _0x5958af.access),
      access: _0x5958af.access
    };
  } catch (_0x54d2be) {
    const _0x28215b = {
      success: false,
      error: _0x54d2be.userMessage || _0x54d2be.message
    };
    return _0x28215b;
  }
});
ipcMain.handle("auth-logout", () => {
  authManager.logout();
  return {
    success: true
  };
});
ipcMain.handle("app-notices", async () => {
  try {
    const _0x6729c3 = require("https");
    return await new Promise(_0x32b50e => {
      const _0x1a2dc5 = {
        success: false
      };
      _0x6729c3.get("https://adwise.co.kr/api/v1/app/notices.php", _0x235bd7 => {
        let _0xef79e0 = "";
        _0x235bd7.on("data", _0x1f1f69 => _0xef79e0 += _0x1f1f69);
        _0x235bd7.on("end", () => {
          try {
            _0x32b50e(JSON.parse(_0xef79e0));
          } catch {
            _0x32b50e({
              success: false
            });
          }
        });
      }).on("error", () => _0x32b50e(_0x1a2dc5));
    });
  } catch {
    return {
      success: false
    };
  }
});
ipcMain.handle("app-settings", async () => {
  try {
    const _0x3ec33d = require("https");
    return await new Promise(_0x2b1a89 => {
      const _0x5567e8 = {
        success: false
      };
      _0x3ec33d.get("https://adwise.co.kr/api/v1/app/settings.php", _0x1e2cdb => {
        let _0x5c9798 = "";
        _0x1e2cdb.on("data", _0x714417 => _0x5c9798 += _0x714417);
        _0x1e2cdb.on("end", () => {
          try {
            _0x2b1a89(JSON.parse(_0x5c9798));
          } catch {
            _0x2b1a89({
              success: false
            });
          }
        });
      }).on("error", () => _0x2b1a89(_0x5567e8));
    });
  } catch {
    return {
      success: false
    };
  }
});
ipcMain.handle("load-settings", () => loadSettings());
ipcMain.handle("check-chromium", () => isChromiumInstalled());
ipcMain.handle("install-chromium", async () => {
  try {
    await ensureChromium(mainWindow);
    return {
      success: true
    };
  } catch (_0x2da5f8) {
    const _0x4b0484 = {
      success: false,
      error: _0x2da5f8.message
    };
    return _0x4b0484;
  }
});
ipcMain.handle("open-file", async (_evt, _opts) => {
  const _dlgOpts = {
    title: "대본 파일 선택",
    filters: [{
      name: "텍스트/마크다운",
      extensions: ["txt", "md", "markdown"]
    }],
    properties: ["openFile"]
  };
  // 렌더러가 시작 폴더(defaultPath)를 넘기면 그 경로에서 열기 (프리셋의 대본 폴더 / 다운로드 폴더)
  if (_opts && _opts.defaultPath) _dlgOpts.defaultPath = _opts.defaultPath;
  const _0xf43f5c = await dialog.showOpenDialog(mainWindow, _dlgOpts);
  if (_0xf43f5c.canceled) {
    return null;
  }
  const _0x1f54ab = _0xf43f5c.filePaths[0];
  const _0x1833e5 = path.dirname(_0x1f54ab);
  const _0x51cad8 = fs.readFileSync(_0x1f54ab, "utf-8");
  const _0x39b21e = [".jpg", ".jpeg", ".png", ".webp"];
  let _0x3e0bce = [];
  try {
    _0x3e0bce = fs.readdirSync(_0x1833e5).filter(_0x985bee => _0x39b21e.includes(path.extname(_0x985bee).toLowerCase())).map(_0x229124 => ({
      name: path.parse(_0x229124).name,
      path: path.join(_0x1833e5, _0x229124)
    }));
  } catch {}
  const _0x41b7d2 = {
    path: _0x1f54ab,
    content: _0x51cad8,
    folder: _0x1833e5,
    characters: _0x3e0bce
  };
  return _0x41b7d2;
});
ipcMain.handle("repair-vrew", async () => {
  try {
    const _0x5196df = await dialog.showOpenDialog(mainWindow, {
      title: "Vrew 파일 선택 (검은화면 복구)",
      filters: [{
        name: "Vrew",
        extensions: ["vrew"]
      }],
      properties: ["openFile"]
    });
    if (_0x5196df.canceled) {
      return {
        error: "취소됨"
      };
    }
    const _0x289055 = _0x5196df.filePaths[0];
    let _0x3dde77;
    const _0x357e5d = _0x289055.replace(".vrew", "");
    for (let _0x863c28 = 1; _0x863c28 <= 99; _0x863c28++) {
      const _0x4abae5 = String(_0x863c28).padStart(2, "0");
      _0x3dde77 = _0x357e5d + "_V" + _0x4abae5 + ".vrew";
      if (!fs.existsSync(_0x3dde77)) {
        break;
      }
    }
    const _0x8a4cd2 = path.join(__dirname, "vrew-repair.py");
    const _0x4a98af = path.join(os.tmpdir(), "_vrew_repair_" + Date.now() + ".py");
    fs.copyFileSync(_0x8a4cd2, _0x4a98af);
    const {
      execFileSync: _0xdd4d0
    } = require("child_process");
    const _0x1647b1 = _0xdd4d0("python", [_0x4a98af, _0x289055, _0x3dde77], {
      encoding: "utf-8",
      timeout: 60000
    }).trim();
    try {
      fs.unlinkSync(_0x4a98af);
    } catch {}
    const _0x51400f = parseInt(_0x1647b1) || 0;
    return {
      success: true,
      total: _0x51400f,
      path: _0x51400f > 0 ? _0x3dde77 : _0x289055
    };
  } catch (_0x333ed2) {
    return {
      error: sanitizeError(_0x333ed2, "복구")
    };
  }
});
ipcMain.handle("select-folder", async () => {
  const _0x2f21da = loadSettings();
  const _0x5386ee = await dialog.showOpenDialog(mainWindow, {
    title: "저장 폴더 선택",
    defaultPath: _0x2f21da.lastOutputDir || os.homedir(),
    properties: ["openDirectory"]
  });
  if (_0x5386ee.canceled) {
    return null;
  }
  const _0x34faf7 = {
    lastOutputDir: _0x5386ee.filePaths[0]
  };
  saveSettings(_0x34faf7);
  return _0x5386ee.filePaths[0];
});
ipcMain.handle("open-folder", (_0x2e031d, _0x478f21) => shell.openPath(_0x478f21));
ipcMain.handle("select-character-images", async () => {
  const _0x259301 = await dialog.showOpenDialog(mainWindow, {
    title: "캐릭터 참조 이미지 선택",
    filters: [{
      name: "이미지",
      extensions: ["jpg", "jpeg", "png", "webp"]
    }],
    properties: ["openFile", "multiSelections"]
  });
  if (_0x259301.canceled) {
    return [];
  }
  return _0x259301.filePaths;
});
ipcMain.handle("select-character-folder", async () => {
  const _0x1537d4 = await dialog.showOpenDialog(mainWindow, {
    title: "캐릭터 이미지 폴더 선택",
    properties: ["openDirectory"]
  });
  if (_0x1537d4.canceled) {
    return null;
  }
  const _0x17980c = _0x1537d4.filePaths[0];
  const _0x2928e8 = [".jpg", ".jpeg", ".png", ".webp"];
  const _0x5b180e = fs.readdirSync(_0x17980c).filter(_0x2c4642 => _0x2928e8.includes(path.extname(_0x2c4642).toLowerCase())).map(_0x37735a => ({
    name: path.parse(_0x37735a).name,
    path: path.join(_0x17980c, _0x37735a)
  }));
  const _0xc2a802 = {
    folder: _0x17980c,
    characters: _0x5b180e
  };
  return _0xc2a802;
});
const PROFILES_DIR = path.join(os.homedir(), ".flow-app", "profiles");
ipcMain.handle("get-profiles", () => {
  const _0x521e92 = loadSettings();
  const _0x1bc3f9 = _0x521e92.profiles || [{
    id: "default",
    name: "기본 계정"
  }];
  return _0x1bc3f9;
});
ipcMain.handle("add-profile", (_0x1e2cd6, _0x112de7) => {
  const _0x198904 = loadSettings();
  const _0x5cfc09 = _0x198904.profiles || [{
    id: "default",
    name: "기본 계정"
  }];
  if (_0x5cfc09.some(_0x13cfe5 => _0x13cfe5.id === _0x112de7)) {
    return {
      success: false,
      error: "이미 존재"
    };
  }
  const _0x246a17 = {
    id: _0x112de7,
    name: _0x112de7
  };
  _0x5cfc09.push(_0x246a17);
  const _0x3afafd = {
    profiles: _0x5cfc09
  };
  saveSettings(_0x3afafd);
  fs.mkdirSync(path.join(PROFILES_DIR, _0x112de7), {
    recursive: true
  });
  return {
    success: true
  };
});
ipcMain.handle("remove-profile", (_0x53d20b, _0x582593) => {
  if (_0x582593 === "default") {
    return {
      success: false,
      error: "기본 계정은 삭제 불가"
    };
  }
  const _0x595c50 = loadSettings();
  const _0x168525 = (_0x595c50.profiles || []).filter(_0x5f046e => _0x5f046e.id !== _0x582593);
  const _0x21711f = {
    profiles: _0x168525
  };
  saveSettings(_0x21711f);
  return {
    success: true
  };
});
const automators = {};
function getAutomator(_0x5a2583 = "default") {
  if (!automators[_0x5a2583]) {
    const {
      FlowAutomator: _0x450503
    } = require("./flow-engine");
    const _0xc4de0c = path.join(PROFILES_DIR, _0x5a2583);
    fs.mkdirSync(_0xc4de0c, {
      recursive: true
    });
    automators[_0x5a2583] = new _0x450503(mainWindow, _0xc4de0c);
  }
  return automators[_0x5a2583];
}
ipcMain.handle("flow-login", async (_0x45348d, _0x16224a) => {
  try {
    const _0x2c6544 = getAutomator(_0x16224a || "default");
    await _0x2c6544.login();
    return {
      success: true
    };
  } catch (_0xd2edd8) {
    const _0xf2a66b = {
      success: false,
      error: _0xd2edd8.message
    };
    return _0xf2a66b;
  }
});
// ─── 절전/모던 스탠바이 방지 (작업 중 PC가 잠들어 작업이 멈추는 것 방지) ───
// prevent-app-suspension: 모니터(화면)는 평소대로 꺼지되, 시스템은 깨어 있어 작업이 계속됨.
// "모든 탭" 배치는 탭마다 start-generation 을 부르므로 참조 카운터로 관리 — 작업이 하나라도
// 진행 중이면 잠금 유지, 전부 끝나면 해제.
let _wakeLockId = null;
let _wakeLockRefs = 0;
function _wakeLog(msg) {
  console.log(msg);
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("log", msg);
  } catch (_e) {}
}
function acquireWakeLock() {
  _wakeLockRefs++;
  if (_wakeLockId === null || !powerSaveBlocker.isStarted(_wakeLockId)) {
    try {
      _wakeLockId = powerSaveBlocker.start("prevent-app-suspension");
      _wakeLog("[절전방지] ON — 작업 중 PC 잠들지 않음 (모니터는 꺼져도 작업 계속)");
    } catch (_e) {
      console.log("[절전방지] 시작 실패: " + _e.message);
    }
  }
}
function releaseWakeLock() {
  _wakeLockRefs = Math.max(0, _wakeLockRefs - 1);
  if (_wakeLockRefs === 0 && _wakeLockId !== null) {
    try {
      if (powerSaveBlocker.isStarted(_wakeLockId)) powerSaveBlocker.stop(_wakeLockId);
      _wakeLog("[절전방지] OFF — 모든 작업 종료, PC 절전 허용");
    } catch (_e) {}
    _wakeLockId = null;
  }
}

ipcMain.handle("start-generation", async (_0xd6a362, _0x36a258) => {
  acquireWakeLock();
  try {
    const _0x846c2b = getAutomator(_0x36a258.profileId || "default");
    await _0x846c2b.run(_0x36a258);
    return {
      success: true
    };
  } catch (_0x3e0e61) {
    const _0x158788 = {
      success: false,
      error: _0x3e0e61.message
    };
    return _0x158788;
  } finally {
    releaseWakeLock();
  }
});
ipcMain.handle("stop-generation", (_0x4b8c70, _0x572421) => {
  const _0x5515ea = automators[_0x572421 || "default"];
  if (_0x5515ea) {
    _0x5515ea.stop();
  }
  return {
    success: true
  };
});
ipcMain.handle("pause-generation", (_0x22c7a3, _0x4fde62) => {
  const _0x19abc8 = automators[_0x4fde62 || "default"];
  if (_0x19abc8) {
    _0x19abc8.pause();
  }
  return {
    success: true
  };
});
ipcMain.handle("resume-generation", (_0x1d9807, _0x530fd5) => {
  const _0x4415ed = automators[_0x530fd5 || "default"];
  if (_0x4415ed) {
    _0x4415ed.resume();
  }
  return {
    success: true
  };
});
ipcMain.handle("vrew:select-file", async () => {
  const _0x4b7aba = await dialog.showOpenDialog(mainWindow, {
    title: "Vrew 파일 선택",
    filters: [{
      name: "Vrew",
      extensions: ["vrew"]
    }],
    properties: ["openFile"]
  });
  if (_0x4b7aba.canceled) {
    return null;
  }
  return _0x4b7aba.filePaths[0];
});
ipcMain.handle("vrew:open-file-direct", async (_0x53701a, _0x303ad2) => {
  try {
    if (!_0x303ad2 || !fs.existsSync(_0x303ad2)) {
      return {
        success: false,
        error: "파일 없음"
      };
    }
    const _0x30cc01 = path.join(os.homedir(), "AppData", "Local", "Programs", "vrew", "Vrew.exe");
    if (!fs.existsSync(_0x30cc01)) {
      return {
        success: false,
        error: "Vrew가 설치되어 있지 않습니다"
      };
    }
    const {
      spawn: _0x2b7d7d
    } = require("child_process");
    _0x2b7d7d(_0x30cc01, [_0x303ad2], {
      detached: true,
      stdio: "ignore",
      cwd: path.dirname(_0x30cc01)
    }).unref();
    return {
      success: true,
      file: path.basename(_0x303ad2),
      filePath: _0x303ad2
    };
  } catch (_0x176a1f) {
    const _0xe52a99 = {
      success: false,
      error: _0x176a1f.message
    };
    return _0xe52a99;
  }
});
ipcMain.handle("vrew:open-in-vrew", async (_0x42f7a7, _0x13ff64) => {
  try {
    let _0x23399e = null;
    const _0x3d7137 = (_0x30e216, _0x17e937 = 0) => {
      if (_0x17e937 > 2 || !fs.existsSync(_0x30e216)) {
        return;
      }
      try {
        for (const _0x3736ef of fs.readdirSync(_0x30e216)) {
          const _0x40b5d1 = path.join(_0x30e216, _0x3736ef);
          const _0x2c1170 = fs.statSync(_0x40b5d1);
          if (_0x3736ef.endsWith(".vrew") && _0x2c1170.isFile()) {
            if (!_0x23399e || _0x2c1170.mtimeMs > _0x23399e.mtime) {
              const _0x379670 = {
                name: _0x3736ef,
                path: _0x40b5d1,
                mtime: _0x2c1170.mtimeMs
              };
              _0x23399e = _0x379670;
            }
          } else if (_0x2c1170.isDirectory() && _0x17e937 < 2) {
            _0x3d7137(_0x40b5d1, _0x17e937 + 1);
          }
        }
      } catch {}
    };
    if (_0x13ff64) {
      _0x3d7137(_0x13ff64);
    }
    if (!_0x23399e) {
      return {
        success: false,
        error: "출력 폴더에 .vrew 파일이 없습니다"
      };
    }
    const _0x332a78 = path.join(os.homedir(), "AppData", "Local", "Programs", "vrew", "Vrew.exe");
    if (!fs.existsSync(_0x332a78)) {
      return {
        success: false,
        error: "Vrew가 설치되어 있지 않습니다"
      };
    }
    const {
      spawn: _0xa44821
    } = require("child_process");
    const _0x4e0ac2 = _0xa44821(_0x332a78, [_0x23399e.path], {
      detached: true,
      stdio: "ignore",
      cwd: path.dirname(_0x332a78)
    });
    _0x4e0ac2.unref();
    const _0x6c9725 = {
      success: true,
      file: _0x23399e.name,
      filePath: _0x23399e.path
    };
    return _0x6c9725;
  } catch (_0x2dc418) {
    const _0x287020 = {
      success: false,
      error: _0x2dc418.message
    };
    return _0x287020;
  }
});
ipcMain.handle("vrew:watch-and-fix", async (_0x233546, _0x27baca) => {
  try {
    if (!_0x27baca || !fs.existsSync(_0x27baca)) {
      return {
        success: false,
        error: "파일 없음"
      };
    }
    const _0x50ebe8 = fs.statSync(_0x27baca).mtimeMs;
    const _0x30d85f = 300000;
    const _0x2ef879 = 2000;
    const _0x5c4740 = Date.now();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("log", "[Vrew] 파일 변경 감시 중... (5분 제한)");
    }
    const _0x423fbf = await new Promise(_0x496fcc => {
      const _0x561c4f = fs.watch(path.dirname(_0x27baca), (_0x12a961, _0x44d37c) => {
        if (_0x44d37c === path.basename(_0x27baca)) {
          try {
            const _0x19f280 = fs.statSync(_0x27baca).mtimeMs;
            if (_0x19f280 > _0x50ebe8 + 1000) {
              _0x561c4f.close();
              _0x496fcc(true);
            }
          } catch {}
        }
      });
      setTimeout(() => {
        _0x561c4f.close();
        _0x496fcc(false);
      }, _0x30d85f);
    });
    if (!_0x423fbf) {
      return {
        success: false,
        timeout: true
      };
    }
    await new Promise(_0xcfce6a => setTimeout(_0xcfce6a, 3000));
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("log", "[Vrew] 파일 변경 감지! 자동 보정 중...");
    }
    const _0x351f37 = path.join(os.tmpdir(), "vrew_autofix_" + Date.now());
    fs.mkdirSync(_0x351f37, {
      recursive: true
    });
    const _0xbd9741 = "import zipfile,sys;zipfile.ZipFile(sys.argv[1],'r').extractall(sys.argv[2]);print('OK')";
    const _0x3e22d6 = path.join(os.tmpdir(), "_unzip_" + Date.now() + ".py");
    fs.writeFileSync(_0x3e22d6, _0xbd9741);
    const {
      execFileSync: _0x1a7c2f
    } = require("child_process");
    _0x1a7c2f("python", [_0x3e22d6, _0x27baca, _0x351f37], {
      encoding: "utf-8"
    });
    try {
      fs.unlinkSync(_0x3e22d6);
    } catch {}
    const _0x1f8478 = path.join(_0x351f37, "project.json");
    const _0x125673 = JSON.parse(fs.readFileSync(_0x1f8478, "utf-8"));
    let _0x416395 = 0;
    let _0x1cc211 = 0;
    const _0x58fa1a = _0x125673.transcript.clips;
    let _0x4636e5 = 0;
    for (let _0x1890bb = 0; _0x1890bb < _0x58fa1a.length; _0x1890bb++) {
      const _0x311ff8 = (_0x58fa1a[_0x1890bb].words || []).filter(_0x2a16e7 => _0x2a16e7.type !== 2);
      if (!_0x311ff8.length) {
        continue;
      }
      const _0x486450 = _0x311ff8[0].originalStartTime || 0;
      const _0x3e54a3 = _0x486450 - _0x4636e5;
      if (_0x3e54a3 > 0.01) {
        _0x416395++;
        for (const _0x15f508 of _0x58fa1a[_0x1890bb].words || []) {
          if (_0x15f508.originalStartTime !== undefined) {
            _0x15f508.originalStartTime = Math.max(0, _0x15f508.originalStartTime - _0x3e54a3);
          }
        }
      }
      const _0x51934f = _0x311ff8[_0x311ff8.length - 1];
      _0x4636e5 = (_0x51934f.originalStartTime || 0) + (_0x51934f.duration || 0);
    }
    let _0x1de4e8 = null;
    for (let _0x5384c6 = 0; _0x5384c6 < _0x58fa1a.length; _0x5384c6++) {
      let _0x173822 = false;
      for (const _0x8c46bb of _0x58fa1a[_0x5384c6].assetIds || []) {
        const _0x1f3d3b = _0x125673.props.assets[_0x8c46bb];
        if (!_0x1f3d3b) {
          continue;
        }
        for (const _0x59789c of _0x1f3d3b.trackIds || []) {
          const _0x1999e3 = _0x125673.props.tracks[_0x59789c];
          if (_0x1999e3 && (_0x1999e3.type === "image" || _0x1999e3.type === "video")) {
            _0x173822 = true;
            _0x1de4e8 = _0x8c46bb;
            break;
          }
        }
        if (_0x173822) {
          break;
        }
      }
      if (!_0x173822 && _0x1de4e8 && !_0x58fa1a[_0x5384c6].assetIds.includes(_0x1de4e8)) {
        _0x58fa1a[_0x5384c6].assetIds.push(_0x1de4e8);
        _0x1cc211++;
      }
    }
    let _0x175ab0 = null;
    for (const _0xd18829 of _0x58fa1a) {
      for (const _0x344f8a of _0xd18829.assetIds || []) {
        const _0x1eea9d = _0x125673.props.assets[_0x344f8a];
        if (!_0x1eea9d) {
          continue;
        }
        for (const _0x3b4bae of _0x1eea9d.trackIds || []) {
          const _0x38c9b8 = _0x125673.props.tracks[_0x3b4bae];
          if (!_0x38c9b8 || _0x38c9b8.type !== "image") {
            continue;
          }
          if (_0x38c9b8.mediaId === _0x175ab0 && _0x38c9b8.assetEffectInfo) {
            delete _0x38c9b8.assetEffectInfo;
            _0x1cc211++;
          }
          _0x175ab0 = _0x38c9b8.mediaId;
        }
      }
    }
    const _0x1d1a91 = _0x125673.files.find(_0x5574d2 => _0x5574d2.sourceFileType === "TTS_DUBBING");
    if (_0x1d1a91) {
      const _0x43249c = require("crypto");
      const _0x349157 = () => _0x43249c.randomBytes(5).toString("hex");
      const _0x1c9ee0 = () => _0x43249c.randomUUID();
      for (let _0x5a7155 = 0; _0x5a7155 < _0x58fa1a.length; _0x5a7155++) {
        let _0x421409 = false;
        for (const _0x57aa0c of _0x58fa1a[_0x5a7155].words || []) {
          for (const _0x440e39 of _0x57aa0c.assetIds || []) {
            const _0x5c8cb7 = _0x125673.props.assets[_0x440e39];
            if (!_0x5c8cb7 || _0x5c8cb7.role !== "sub") {
              continue;
            }
            for (const _0x110347 of _0x5c8cb7.trackIds || []) {
              if (_0x125673.props.tracks[_0x110347]?.type === "ttsDubbing") {
                _0x421409 = true;
              }
            }
          }
        }
        if (!_0x421409) {
          const _0x1cbe8e = _0x349157();
          const _0x3371a4 = _0x1c9ee0();
          _0x125673.props.tracks[_0x1cbe8e] = {
            trackId: _0x1cbe8e,
            mediaId: _0x1d1a91.mediaId,
            volume: 0,
            fade: {
              in: false,
              out: false
            },
            sourceIn: 0,
            sourceOut: _0x1d1a91.videoAudioMetaInfo?.duration || 1,
            loop: false,
            playbackRate: 1,
            type: "ttsDubbing",
            ttsFileInfo: {
              duration: _0x1d1a91.videoAudioMetaInfo?.duration || 1,
              speaker: _0x125673.props.lastTTSSettings?.speaker || {
                name: "butter_f",
                provider: "vrew",
                lang: "ko-KR"
              },
              volume: 0,
              speed: 0,
              pitch: 0,
              version: "v4",
              text: {
                processed: " ",
                raw: " ",
                textAspectLang: "ko-KR"
              }
            }
          };
          const _0x2fe7f1 = {
            trackIds: [_0x1cbe8e],
            role: "sub"
          };
          _0x125673.props.assets[_0x3371a4] = _0x2fe7f1;
          const _0x3aed1c = (_0x58fa1a[_0x5a7155].words || []).find(_0x4233b2 => _0x4233b2.type !== 2);
          if (_0x3aed1c) {
            if (!_0x3aed1c.assetIds) {
              _0x3aed1c.assetIds = [];
            }
            _0x3aed1c.assetIds.push(_0x3371a4);
          }
          _0x1cc211++;
        }
      }
    }
    for (let _0x4c2a8f = 0; _0x4c2a8f < _0x58fa1a.length; _0x4c2a8f++) {
      const _0x5a50bc = (_0x58fa1a[_0x4c2a8f].words || []).filter(_0x2346a9 => _0x2346a9.type !== 2);
      if (!_0x5a50bc.length) {
        continue;
      }
      const _0x1e7c2c = _0x5a50bc.map(_0x40ec09 => _0x40ec09.text || "").join(" ").trim();
      if (!_0x1e7c2c) {
        continue;
      }
      const _0x293728 = _0x58fa1a[_0x4c2a8f].captions;
      if (_0x293728 && _0x293728[0] && _0x293728[0].text && _0x293728[0].text[0]) {
        const _0x2b5919 = _0x293728[0].text[0].insert || "";
        if (_0x2b5919.trim() !== _0x1e7c2c) {
          _0x293728[0].text[0].insert = _0x1e7c2c;
        }
      }
    }
    const _0x44af02 = Object.values(_0x125673.props.tracks || {}).some(_0x4281be => _0x4281be && _0x4281be.type === "ttsClip" && _0x4281be.volume > 0);
    let _0x2a452b = 0;
    for (let _0x25e339 = 0; _0x25e339 < _0x58fa1a.length; _0x25e339++) {
      if (_0x44af02) {
        break;
      }
      let _0x22073a = null;
      for (const _0x2ad036 of _0x58fa1a[_0x25e339].words || []) {
        for (const _0x5af87d of _0x2ad036.assetIds || []) {
          const _0x203f0f = _0x125673.props.assets[_0x5af87d];
          if (!_0x203f0f) {
            continue;
          }
          for (const _0x203482 of _0x203f0f.trackIds || []) {
            const _0x2e5b6d = _0x125673.props.tracks[_0x203482];
            if (_0x2e5b6d && (_0x2e5b6d.type === "ttsDubbing" || _0x2e5b6d.type === "ttsClip") && _0x2e5b6d.ttsFileInfo && _0x2e5b6d.ttsFileInfo.duration > 0) {
              _0x22073a = _0x2e5b6d.ttsFileInfo.duration;
            }
          }
        }
        if (_0x22073a !== null) {
          break;
        }
      }
      if (_0x22073a === null) {
        continue;
      }
      const _0x4adfb2 = [_0x25e339];
      for (let _0x22a5c4 = _0x25e339 + 1; _0x22a5c4 < _0x58fa1a.length; _0x22a5c4++) {
        let _0x3050bd = false;
        for (const _0xc53e50 of _0x58fa1a[_0x22a5c4].words || []) {
          for (const _0x978e4f of _0xc53e50.assetIds || []) {
            const _0x28e06a = _0x125673.props.assets[_0x978e4f];
            if (!_0x28e06a) {
              continue;
            }
            for (const _0x14652e of _0x28e06a.trackIds || []) {
              const _0xc2854e = _0x125673.props.tracks[_0x14652e];
              if (_0xc2854e && (_0xc2854e.type === "ttsDubbing" || _0xc2854e.type === "ttsClip") && _0xc2854e.ttsFileInfo && _0xc2854e.ttsFileInfo.duration > 0) {
                _0x3050bd = true;
              }
            }
          }
          if (_0x3050bd) {
            break;
          }
        }
        if (_0x3050bd) {
          break;
        }
        _0x4adfb2.push(_0x22a5c4);
      }
      let _0x223154 = 0;
      const _0xfbca27 = [];
      for (const _0xd48eea of _0x4adfb2) {
        for (const _0x187301 of _0x58fa1a[_0xd48eea].words || []) {
          if (_0x187301.type === 0 || _0x187301.type === 7) {
            _0x223154 += _0x187301.duration || 0;
            _0xfbca27.push(_0x187301);
          }
        }
      }
      if (_0x223154 <= 0 || Math.abs(_0x223154 - _0x22073a) < 0.05) {
        continue;
      }
      const _0x215bd9 = _0x22073a / _0x223154;
      for (const _0x52c118 of _0xfbca27) {
        _0x52c118.duration = Math.max(0.05, (_0x52c118.duration || 0) * _0x215bd9);
        _0x52c118.originalDuration = _0x52c118.duration;
      }
      _0x2a452b += _0x4adfb2.length;
      _0x25e339 = _0x4adfb2[_0x4adfb2.length - 1];
    }
    const _0x1ed325 = 2;
    for (let _0xaadd6c = 0; _0xaadd6c < _0x58fa1a.length; _0xaadd6c++) {
      const _0x35fe90 = (_0x58fa1a[_0xaadd6c].words || []).filter(_0x3e4f8c => _0x3e4f8c.type === 0 || _0x3e4f8c.type === 7);
      if (!_0x35fe90.length) {
        continue;
      }
      const _0x40f74a = _0x35fe90.reduce((_0x49dcb4, _0x17107a) => _0x49dcb4 + (_0x17107a.duration || 0), 0);
      if (_0x40f74a < _0x1ed325) {
        const _0x1001b5 = _0x1ed325 - _0x40f74a;
        _0x35fe90[_0x35fe90.length - 1].duration = (_0x35fe90[_0x35fe90.length - 1].duration || 0) + _0x1001b5;
        _0x35fe90[_0x35fe90.length - 1].originalDuration = _0x35fe90[_0x35fe90.length - 1].duration;
      }
    }
    if (_0x2a452b > 0) {
      let _0x48cd32 = 0;
      for (let _0xc6636f = 0; _0xc6636f < _0x58fa1a.length; _0xc6636f++) {
        const _0x26405e = _0x48cd32;
        for (const _0x4d6047 of _0x58fa1a[_0xc6636f].words || []) {
          if (_0x4d6047.type === 0 || _0x4d6047.type === 7) {
            _0x4d6047.originalStartTime = _0x48cd32;
            _0x48cd32 += _0x4d6047.duration || 0;
          } else if (_0x4d6047.type === 1) {
            _0x4d6047.originalStartTime = _0x48cd32;
            _0x48cd32 += _0x4d6047.duration || 0;
          } else if (_0x4d6047.type === 2) {
            _0x4d6047.originalStartTime = _0x48cd32;
          }
        }
        const _0x179adb = _0xc6636f + 1 < _0x58fa1a.length && (_0x58fa1a[_0xc6636f + 1].words || []).some(_0x5bed77 => (_0x5bed77.assetIds || []).some(_0x53ada4 => {
          const _0x5a4c5d = _0x125673.props.assets[_0x53ada4];
          if (!_0x5a4c5d) {
            return false;
          }
          return (_0x5a4c5d.trackIds || []).some(_0x1d9536 => {
            const _0xac9101 = _0x125673.props.tracks[_0x1d9536];
            return _0xac9101 && (_0xac9101.type === "ttsDubbing" || _0xac9101.type === "ttsClip") && _0xac9101.ttsFileInfo && _0xac9101.ttsFileInfo.duration > 0;
          });
        }));
        if (_0x179adb) {
          _0x48cd32 += 0.3;
        }
      }
    }
    fs.writeFileSync(_0x1f8478, JSON.stringify(_0x125673), "utf-8");
    const _0x40b628 = _0x27baca.replace(".vrew", "_fixed.vrew");
    const _0x17e15b = path.join(__dirname, "vrew-maker.py");
    const _0x147171 = path.join(os.tmpdir(), "_maker_" + Date.now() + ".py");
    fs.copyFileSync(_0x17e15b, _0x147171);
    _0x1a7c2f("python", [_0x147171, _0x351f37, _0x40b628], {
      encoding: "utf-8",
      timeout: 30000
    });
    try {
      fs.unlinkSync(_0x147171);
    } catch {}
    try {
      fs.rmSync(_0x351f37, {
        recursive: true,
        force: true
      });
    } catch {}
    let _0x5ee7a9 = _0x40b628;
    try {
      const _0x13998a = path.join(__dirname, "vrew-repair.py");
      const _0x3b9e2d = _0x27baca.replace(".vrew", "_fixed_V01.vrew");
      const _0x3027a4 = path.join(os.tmpdir(), "_repair_" + Date.now() + ".py");
      fs.copyFileSync(_0x13998a, _0x3027a4);
      const _0x463a19 = _0x1a7c2f("python", [_0x3027a4, _0x40b628, _0x3b9e2d], {
        encoding: "utf-8",
        timeout: 60000
      }).trim();
      try {
        fs.unlinkSync(_0x3027a4);
      } catch {}
      if (parseInt(_0x463a19) > 0 && fs.existsSync(_0x3b9e2d)) {
        _0x5ee7a9 = _0x3b9e2d;
        try {
          fs.unlinkSync(_0x40b628);
        } catch {}
      }
    } catch (_0x3cd9cd) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("log", "[Vrew] 추가 보정 스킵: " + sanitizeError(_0x3cd9cd, "추가 보정"));
      }
    }
    const _0x4d774c = path.join(os.homedir(), "AppData", "Local", "Programs", "vrew", "Vrew.exe");
    if (fs.existsSync(_0x4d774c)) {
      const {
        spawn: _0x338c0b
      } = require("child_process");
      _0x338c0b(_0x4d774c, [_0x5ee7a9], {
        detached: true,
        stdio: "ignore",
        cwd: path.dirname(_0x4d774c)
      }).unref();
    }
    return {
      success: true,
      file: path.basename(_0x5ee7a9),
      filePath: _0x5ee7a9,
      gapsFixed: _0x416395,
      blackFixed: _0x1cc211
    };
  } catch (_0x2d5cdc) {
    return {
      success: false,
      error: sanitizeError(_0x2d5cdc, "자동 보정")
    };
  }
});
ipcMain.handle("vrew:fix-gaps", async () => {
  try {
    const _0x22598b = await dialog.showOpenDialog(mainWindow, {
      title: "Vrew 파일 선택 (보정)",
      filters: [{
        name: "Vrew",
        extensions: ["vrew"]
      }],
      properties: ["openFile"]
    });
    if (_0x22598b.canceled) {
      return {
        success: false,
        error: "취소됨"
      };
    }
    const _0x9c6a8f = _0x22598b.filePaths[0];
    const _0x68df71 = (() => {
      const {
        execFileSync: _0x1a0732
      } = require("child_process");
      const _0x328bf5 = path.join(os.tmpdir(), "vrew_fix_" + Date.now());
      fs.mkdirSync(_0x328bf5, {
        recursive: true
      });
      const _0x2a77f4 = "\nimport zipfile, sys, os\nwith zipfile.ZipFile(sys.argv[1], 'r') as z:\n    z.extractall(sys.argv[2])\nprint('OK')\n";
      const _0x245165 = path.join(os.tmpdir(), "_vrew_unzip_" + Date.now() + ".py");
      fs.writeFileSync(_0x245165, _0x2a77f4);
      _0x1a0732("python", [_0x245165, _0x9c6a8f, _0x328bf5], {
        encoding: "utf-8"
      });
      try {
        fs.unlinkSync(_0x245165);
      } catch {}
      return _0x328bf5;
    })();
    const _0x4b70d0 = _0x68df71;
    const _0x2723c0 = path.join(_0x4b70d0, "project.json");
    const _0x3cbab0 = JSON.parse(fs.readFileSync(_0x2723c0, "utf-8"));
    let _0x89354 = 0;
    let _0x5a254f = 0;
    const _0x273c86 = _0x3cbab0.transcript.clips;
    let _0x4505ce = 0;
    for (let _0xd97b7e = 0; _0xd97b7e < _0x273c86.length; _0xd97b7e++) {
      const _0x43c97c = _0x273c86[_0xd97b7e].words || [];
      const _0x5e0640 = _0x43c97c.filter(_0x31f9a4 => _0x31f9a4.type !== 2);
      if (_0x5e0640.length === 0) {
        continue;
      }
      const _0x4f2186 = _0x5e0640[0].originalStartTime || 0;
      const _0x4dcf5a = _0x4f2186 - _0x4505ce;
      if (_0x4dcf5a > 0.01) {
        _0x89354++;
        for (const _0x59e913 of _0x43c97c) {
          if (_0x59e913.originalStartTime !== undefined) {
            _0x59e913.originalStartTime = Math.max(0, _0x59e913.originalStartTime - _0x4dcf5a);
          }
        }
      }
      const _0x22f758 = _0x5e0640[_0x5e0640.length - 1];
      _0x4505ce = (_0x22f758.originalStartTime || 0) + (_0x22f758.duration || 0);
    }
    let _0x4aa80f = null;
    for (let _0x5a7134 = 0; _0x5a7134 < _0x273c86.length; _0x5a7134++) {
      const _0x3a54a4 = _0x273c86[_0x5a7134].assetIds || [];
      let _0x1f67e3 = false;
      for (const _0x3e1781 of _0x3a54a4) {
        const _0x215a66 = _0x3cbab0.props.assets[_0x3e1781];
        if (!_0x215a66) {
          continue;
        }
        for (const _0x2ff503 of _0x215a66.trackIds || []) {
          const _0x22ef70 = _0x3cbab0.props.tracks[_0x2ff503];
          if (_0x22ef70 && (_0x22ef70.type === "image" || _0x22ef70.type === "video")) {
            _0x1f67e3 = true;
            _0x4aa80f = _0x3e1781;
            break;
          }
        }
        if (_0x1f67e3) {
          break;
        }
      }
      if (!_0x1f67e3 && _0x4aa80f) {
        if (!_0x273c86[_0x5a7134].assetIds.includes(_0x4aa80f)) {
          _0x273c86[_0x5a7134].assetIds.push(_0x4aa80f);
          _0x5a254f++;
        }
      }
    }
    for (let _0x5ecf33 = 0; _0x5ecf33 < _0x273c86.length; _0x5ecf33++) {
      const _0xa94960 = _0x273c86[_0x5ecf33].words || [];
      const _0x264115 = _0xa94960.filter(_0x5cfc9b => _0x5cfc9b.type !== 2);
      if (!_0x264115.length) {
        continue;
      }
      const _0x55fa68 = _0x264115[0].originalStartTime || 0;
      const _0x211bf2 = _0x264115[_0x264115.length - 1];
      const _0x474755 = (_0x211bf2.originalStartTime || 0) + (_0x211bf2.duration || 0);
      const _0x38a786 = _0x474755 - _0x55fa68;
      let _0x12580a = _0x38a786;
      const _0x344977 = _0x273c86[_0x5ecf33].assetIds || [];
      for (const _0xb9a211 of _0xa94960) {
        for (const _0x482d79 of _0xb9a211.assetIds || []) {
          const _0x56a5b5 = _0x3cbab0.props.assets[_0x482d79];
          if (!_0x56a5b5) {
            continue;
          }
          for (const _0x19e2cf of _0x56a5b5.trackIds || []) {
            const _0x1f50ab = _0x3cbab0.props.tracks[_0x19e2cf];
            if (_0x1f50ab && _0x1f50ab.type === "ttsDubbing" && _0x1f50ab.sourceOut > 0) {
              _0x12580a = Math.max(_0x12580a, _0x1f50ab.sourceOut);
            }
          }
        }
      }
      for (const _0x5c70d8 of _0x344977) {
        const _0x155444 = _0x3cbab0.props.assets[_0x5c70d8];
        if (!_0x155444) {
          continue;
        }
        for (const _0x193976 of _0x155444.trackIds || []) {
          const _0x42996f = _0x3cbab0.props.tracks[_0x193976];
          if (!_0x42996f) {
            continue;
          }
          if (_0x42996f.type === "image") {}
          if (_0x42996f.type === "video" && _0x42996f.sourceOut < _0x12580a) {
            _0x42996f.sourceOut = _0x12580a;
            _0x5a254f++;
          }
        }
      }
    }
    let _0x3b2f2c = null;
    let _0x3041ad = 0;
    for (let _0x20e61b = 0; _0x20e61b < _0x273c86.length; _0x20e61b++) {
      const _0x2167f5 = _0x273c86[_0x20e61b].assetIds || [];
      for (const _0x3a37e6 of _0x2167f5) {
        const _0x24af2 = _0x3cbab0.props.assets[_0x3a37e6];
        if (!_0x24af2) {
          continue;
        }
        for (const _0x554d48 of _0x24af2.trackIds || []) {
          const _0x38fd69 = _0x3cbab0.props.tracks[_0x554d48];
          if (!_0x38fd69 || _0x38fd69.type !== "image") {
            continue;
          }
          if (_0x38fd69.mediaId === _0x3b2f2c && _0x38fd69.assetEffectInfo) {
            delete _0x38fd69.assetEffectInfo;
            _0x3041ad++;
          }
          _0x3b2f2c = _0x38fd69.mediaId;
        }
      }
    }
    _0x5a254f += _0x3041ad;
    const _0x4a1ae1 = _0x3cbab0.files.find(_0x515a6b => _0x515a6b.sourceFileType === "TTS_DUBBING");
    if (_0x4a1ae1) {
      const _0x1c31a4 = require("crypto");
      const _0x276696 = () => _0x1c31a4.randomBytes(5).toString("hex");
      const _0x4c3d48 = () => _0x1c31a4.randomUUID();
      for (let _0x207b91 = 0; _0x207b91 < _0x273c86.length; _0x207b91++) {
        let _0x92195 = false;
        for (const _0x5cb6af of _0x273c86[_0x207b91].words || []) {
          for (const _0x2763ad of _0x5cb6af.assetIds || []) {
            const _0x15c98d = _0x3cbab0.props.assets[_0x2763ad];
            if (!_0x15c98d || _0x15c98d.role !== "sub") {
              continue;
            }
            for (const _0x4fab46 of _0x15c98d.trackIds || []) {
              if (_0x3cbab0.props.tracks[_0x4fab46]?.type === "ttsDubbing") {
                _0x92195 = true;
              }
            }
          }
        }
        if (!_0x92195) {
          const _0x31fce9 = _0x276696();
          const _0x1be2f6 = _0x4c3d48();
          _0x3cbab0.props.tracks[_0x31fce9] = {
            trackId: _0x31fce9,
            mediaId: _0x4a1ae1.mediaId,
            volume: 0,
            fade: {
              in: false,
              out: false
            },
            sourceIn: 0,
            sourceOut: _0x4a1ae1.videoAudioMetaInfo?.duration || 1,
            loop: false,
            playbackRate: 1,
            type: "ttsDubbing",
            ttsFileInfo: {
              duration: _0x4a1ae1.videoAudioMetaInfo?.duration || 1,
              speaker: _0x3cbab0.props.lastTTSSettings?.speaker || {
                name: "butter_f",
                provider: "vrew",
                lang: "ko-KR"
              },
              volume: 0,
              speed: 0,
              pitch: 0,
              version: "v4",
              text: {
                processed: " ",
                raw: " ",
                textAspectLang: "ko-KR"
              }
            }
          };
          const _0x386516 = {
            trackIds: [_0x31fce9],
            role: "sub"
          };
          _0x3cbab0.props.assets[_0x1be2f6] = _0x386516;
          const _0x2af684 = (_0x273c86[_0x207b91].words || []).find(_0x5b405a => _0x5b405a.type !== 2);
          if (_0x2af684) {
            if (!_0x2af684.assetIds) {
              _0x2af684.assetIds = [];
            }
            _0x2af684.assetIds.push(_0x1be2f6);
          }
          _0x5a254f++;
        }
      }
    }
    for (let _0xe6ae2d = 0; _0xe6ae2d < _0x273c86.length; _0xe6ae2d++) {
      const _0x5939ce = (_0x273c86[_0xe6ae2d].words || []).filter(_0x444f5b => _0x444f5b.type !== 2);
      if (!_0x5939ce.length) {
        continue;
      }
      const _0x56eb1f = _0x5939ce.map(_0x579bb5 => _0x579bb5.text || "").join(" ").trim();
      if (!_0x56eb1f) {
        continue;
      }
      const _0x1b3e0d = _0x273c86[_0xe6ae2d].captions;
      if (_0x1b3e0d && _0x1b3e0d[0] && _0x1b3e0d[0].text && _0x1b3e0d[0].text[0]) {
        const _0x3338bb = _0x1b3e0d[0].text[0].insert || "";
        if (_0x3338bb.trim() !== _0x56eb1f) {
          _0x1b3e0d[0].text[0].insert = _0x56eb1f;
        }
      }
    }
    const _0x209f15 = Object.values(_0x3cbab0.props.tracks || {}).some(_0x5a6431 => _0x5a6431 && _0x5a6431.type === "ttsClip" && _0x5a6431.volume > 0);
    let _0xa5b9f6 = 0;
    for (let _0x227fce = 0; _0x227fce < _0x273c86.length; _0x227fce++) {
      if (_0x209f15) {
        break;
      }
      let _0x5c72ec = null;
      for (const _0x4cbeee of _0x273c86[_0x227fce].words || []) {
        for (const _0x59974a of _0x4cbeee.assetIds || []) {
          const _0x1cb07a = _0x3cbab0.props.assets[_0x59974a];
          if (!_0x1cb07a) {
            continue;
          }
          for (const _0x5c9e71 of _0x1cb07a.trackIds || []) {
            const _0x499b5f = _0x3cbab0.props.tracks[_0x5c9e71];
            if (_0x499b5f && (_0x499b5f.type === "ttsDubbing" || _0x499b5f.type === "ttsClip") && _0x499b5f.ttsFileInfo && _0x499b5f.ttsFileInfo.duration > 0) {
              _0x5c72ec = _0x499b5f.ttsFileInfo.duration;
            }
          }
        }
        if (_0x5c72ec !== null) {
          break;
        }
      }
      if (_0x5c72ec === null) {
        continue;
      }
      const _0x129c4f = [_0x227fce];
      for (let _0x11f9f4 = _0x227fce + 1; _0x11f9f4 < _0x273c86.length; _0x11f9f4++) {
        let _0xce7e3f = false;
        for (const _0x2b51f8 of _0x273c86[_0x11f9f4].words || []) {
          for (const _0x556208 of _0x2b51f8.assetIds || []) {
            const _0x5d3b6a = _0x3cbab0.props.assets[_0x556208];
            if (!_0x5d3b6a) {
              continue;
            }
            for (const _0x258b91 of _0x5d3b6a.trackIds || []) {
              const _0x1426b7 = _0x3cbab0.props.tracks[_0x258b91];
              if (_0x1426b7 && (_0x1426b7.type === "ttsDubbing" || _0x1426b7.type === "ttsClip") && _0x1426b7.ttsFileInfo && _0x1426b7.ttsFileInfo.duration > 0) {
                _0xce7e3f = true;
              }
            }
          }
          if (_0xce7e3f) {
            break;
          }
        }
        if (_0xce7e3f) {
          break;
        }
        _0x129c4f.push(_0x11f9f4);
      }
      let _0x5652c6 = 0;
      const _0x46a6ba = [];
      for (const _0x35081e of _0x129c4f) {
        for (const _0x46748a of _0x273c86[_0x35081e].words || []) {
          if (_0x46748a.type === 0 || _0x46748a.type === 7) {
            _0x5652c6 += _0x46748a.duration || 0;
            _0x46a6ba.push(_0x46748a);
          }
        }
      }
      if (_0x5652c6 > 0 && Math.abs(_0x5652c6 - _0x5c72ec) >= 0.05) {
        const _0x3b21ea = _0x5c72ec / _0x5652c6;
        for (const _0x9280c2 of _0x46a6ba) {
          _0x9280c2.duration = Math.max(0.05, (_0x9280c2.duration || 0) * _0x3b21ea);
          _0x9280c2.originalDuration = _0x9280c2.duration;
        }
        _0xa5b9f6 += _0x129c4f.length;
      }
      _0x227fce = _0x129c4f[_0x129c4f.length - 1];
    }
    const _0x5de033 = 2;
    for (let _0x2be0b6 = 0; _0x2be0b6 < _0x273c86.length; _0x2be0b6++) {
      const _0x5b009d = (_0x273c86[_0x2be0b6].words || []).filter(_0x422d72 => _0x422d72.type === 0 || _0x422d72.type === 7);
      if (!_0x5b009d.length) {
        continue;
      }
      const _0x2d9e12 = _0x5b009d.reduce((_0xda4a87, _0x432317) => _0xda4a87 + (_0x432317.duration || 0), 0);
      if (_0x2d9e12 < _0x5de033) {
        _0x5b009d[_0x5b009d.length - 1].duration = (_0x5b009d[_0x5b009d.length - 1].duration || 0) + (_0x5de033 - _0x2d9e12);
        _0x5b009d[_0x5b009d.length - 1].originalDuration = _0x5b009d[_0x5b009d.length - 1].duration;
      }
    }
    if (_0xa5b9f6 > 0) {
      let _0x1099a2 = 0;
      for (let _0x5dce48 = 0; _0x5dce48 < _0x273c86.length; _0x5dce48++) {
        for (const _0x40a270 of _0x273c86[_0x5dce48].words || []) {
          if (_0x40a270.type === 0 || _0x40a270.type === 7 || _0x40a270.type === 1) {
            _0x40a270.originalStartTime = _0x1099a2;
            _0x1099a2 += _0x40a270.duration || 0;
          } else if (_0x40a270.type === 2) {
            _0x40a270.originalStartTime = _0x1099a2;
          }
        }
        const _0x3d6895 = _0x5dce48 + 1 < _0x273c86.length && (_0x273c86[_0x5dce48 + 1].words || []).some(_0x1f6465 => (_0x1f6465.assetIds || []).some(_0x21d592 => {
          const _0x2dc92a = _0x3cbab0.props.assets[_0x21d592];
          if (!_0x2dc92a) {
            return false;
          }
          return (_0x2dc92a.trackIds || []).some(_0x29c32c => {
            const _0x111114 = _0x3cbab0.props.tracks[_0x29c32c];
            return _0x111114 && (_0x111114.type === "ttsDubbing" || _0x111114.type === "ttsClip") && _0x111114.ttsFileInfo && _0x111114.ttsFileInfo.duration > 0;
          });
        }));
        if (_0x3d6895) {
          _0x1099a2 += 0.3;
        }
      }
    }
    const _0x11f2f0 = _0x1ba093 => {
      if (!_0x1ba093) {
        return _0x1ba093;
      }
      return _0x1ba093.replace(/[\u2013\u2014\u2e3b]/g, " ").replace(/[\x00-\x19]/g, "").replace(/[\u2000-\u2012\u2015-\u2bff]/g, "").replace(/[\u3003-\u303f\u3099-\u309c]/g, "").replace(/[()*/+:;<=>[\\\]^_{|}~@`'"]/g, "").replace(/[\u300a\u300b\u3008\u3009\u300c\u300d]/g, "").replace(/\s+/g, " ").trim();
    };
    let _0x487c14 = 0;
    let _0x14d72d = 0;
    for (const _0x492741 of Object.keys(_0x3cbab0.props.tracks || {})) {
      const _0x59417a = _0x3cbab0.props.tracks[_0x492741];
      if (!_0x59417a || _0x59417a.type !== "ttsDubbing") {
        continue;
      }
      const _0x286f1c = _0x59417a.ttsFileInfo;
      if (_0x286f1c) {
        const _0x5b92a2 = _0x286f1c.text;
        if (_0x5b92a2) {
          const _0x232fcd = _0x11f2f0(_0x5b92a2.raw);
          if (_0x232fcd !== _0x5b92a2.raw) {
            _0x5b92a2.raw = _0x232fcd;
            _0x14d72d++;
          }
          const _0x5cced5 = _0x11f2f0(_0x5b92a2.processed);
          if (_0x5cced5 !== _0x5b92a2.processed) {
            _0x5b92a2.processed = _0x5cced5;
          }
        }
      }
    }
    for (const _0x5155d2 of Object.keys(_0x3cbab0.props.ttsClipInfosMap || {})) {
      const _0x276d46 = _0x3cbab0.props.ttsClipInfosMap[_0x5155d2];
      const _0xfa0e88 = _0x276d46 && _0x276d46.text;
      if (_0xfa0e88) {
        const _0x799e43 = _0x11f2f0(_0xfa0e88.raw);
        if (_0x799e43 !== _0xfa0e88.raw) {
          _0xfa0e88.raw = _0x799e43;
          _0x14d72d++;
        }
        const _0x5c59fa = _0x11f2f0(_0xfa0e88.processed);
        if (_0x5c59fa !== _0xfa0e88.processed) {
          _0xfa0e88.processed = _0x5c59fa;
        }
      }
    }
    fs.writeFileSync(_0x2723c0, JSON.stringify(_0x3cbab0), "utf-8");
    const _0x384cd6 = _0x9c6a8f.replace(".vrew", "_fixed.vrew");
    const _0x495fe6 = path.join(__dirname, "vrew-maker.py");
    const _0x4ca504 = path.join(os.tmpdir(), "_vrew_maker_fix_" + Date.now() + ".py");
    fs.copyFileSync(_0x495fe6, _0x4ca504);
    const {
      execFileSync: _0x4f3123
    } = require("child_process");
    _0x4f3123("python", [_0x4ca504, _0x4b70d0, _0x384cd6], {
      encoding: "utf-8",
      timeout: 30000
    });
    try {
      fs.unlinkSync(_0x4ca504);
    } catch {}
    try {
      fs.rmSync(_0x4b70d0, {
        recursive: true,
        force: true
      });
    } catch {}
    const _0x4c3fe3 = path.join(os.homedir(), "AppData", "Local", "Programs", "vrew", "Vrew.exe");
    if (fs.existsSync(_0x4c3fe3)) {
      const {
        spawn: _0xca6864
      } = require("child_process");
      const _0x530571 = _0xca6864(_0x4c3fe3, [_0x384cd6], {
        detached: true,
        stdio: "ignore",
        cwd: path.dirname(_0x4c3fe3)
      });
      _0x530571.unref();
    }
    return {
      success: true,
      file: path.basename(_0x384cd6),
      gapsFixed: _0x89354,
      blackFixed: _0x5a254f,
      volumeFixed: _0x487c14,
      textCleaned: _0x14d72d
    };
  } catch (_0x15b64d) {
    return {
      success: false,
      error: sanitizeError(_0x15b64d, "보정")
    };
  }
});