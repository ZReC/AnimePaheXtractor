const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { AppImageUpdater, MacUpdater, NsisUpdater } = require('electron-updater');
const { Database } = require('./database');

// open command
const child_process = require('child_process');
const open = (() => {
  switch (process.platform) {
    case "win32":
      return "start";
    case "darwin":
      return "open";
    case "linux":
      return "xdg-open";
  }
})();

const updater = (() => {
  let u, options = {
    requestHeaders: {
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    },
    provider: 'github',
    owner: 'ZReC',
    repo: 'AnimePaheXtractor',
  };

  switch (process.platform) {
    case "win32":
      u = new NsisUpdater(options);
      break;
    case "darwin":
      u = new MacUpdater(options);
      break;
    default:
      u = new AppImageUpdater(options);
  }

  u.autoDownload = false;
  u.autoInstallOnAppQuit = true;

  return u;
})();

const lockInstance = app.requestSingleInstanceLock();
if (!lockInstance)
  app.quit();

const isDev = process.argv[2] == '--dev';

function versionArray(str) {
  const found = str.match(/([0-9]+).([0-9]+).([0-9]+)/);
  if (found.length != 4)
    throw new Error("invalid version");

  let arr = [];
  for (let i = 1; i < 4; i++) {
    arr.push(BigInt(found[i]));
  }
  return arr;
}

const [verMajor, verMinor, verPatch] = versionArray(app.getVersion());

function createWindow() {
  const pathIndex = path.join(__dirname, 'renderer', 'index');

  const mainWindow = new BrowserWindow({
    width: 800,
    minWidth: 800,
    height: 450,
    minHeight: 450,
    frame: false,
    show: false,
    backgroundColor: '#0000',
    webPreferences: {
      preload: path.join(pathIndex, 'preload.js'),
      sandbox: true
    }
  });

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized())
        mainWindow.restore();
      mainWindow.focus();
    }

  });

  // Close all windows when main is gone
  mainWindow.once('closed', () => { app.quit(); });

  mainWindow.once('ready-to-show', () => { mainWindow.show(); });

  // Load index.html
  mainWindow.loadFile(path.join(pathIndex, 'index.html'));

  if (isDev)
    mainWindow.webContents.openDevTools();

  return mainWindow;
}

/** 
 * This method will be called when Electron has finished
 * initialization and is ready to create browser windows.
 * Some APIs can only be used after this event occurs.
 */
app.whenReady().then(async () => {
  try {
    // setup config database
    const configDB = await Database.open('config');
    await configDB.createTable('settings', ['key', Database.TYPE.TEXT], ['value', Database.TYPE.BLOB]);
    let path = await configDB.select('settings', ['value'], 'key="library_path"');

    if (!path) {
      let library_path;
      do {
        const { canceled, filePaths } = await dialog.showOpenDialog(undefined, {
          title: 'Select a folder to store multimedia! (>.<)/',
          properties: ['openDirectory'],
          message: 'OwO'
        });

        if (!canceled)
          library_path = filePaths?.at(0);
      } while (library_path == undefined);

      await configDB.insert('settings', ['key', 'library_path'], ['value', library_path]);
      path = await configDB.select('settings', ['value'], 'key = "library_path"');
    }
    const a_p = require('./apextractor');

    a_p.library.directory = path.value;

    const mainWindow = createWindow();

    app.on('activate', () => {
      // On macOS it's common to re-create a window in the app when the
      // dock icon is clicked and there are no other windows open.
      if (BrowserWindow.getAllWindows().length === 0)
        createWindow();
    });

    ipcMain.on('mainWindow:minimize', () => {
      mainWindow.minimize();
    });
    ipcMain.on('mainWindow:close', () => {
      mainWindow.close();
    });

    ipcMain.on('command:open', (_, what) => {
      const url = new URL(what);
      child_process.exec(`${open} ${url}`);
    });

    // Hardcoded current github repo
    ipcMain.on('social:repo', () => child_process.exec(`${open} https://github.com/ZReC/AnimePaheXtractor/`));

    ipcMain.handle('updater:check', async () => {
      const r = { severity: 0, version: undefined };
      try {
        const result = await updater.checkForUpdates();
        const [major, minor, patch] = versionArray(result.updateInfo.version);

        r.version = result.updateInfo.version;
        r.severity =
          major > verMajor && 3 ||
          minor > verMinor && 2 ||
          patch > verPatch && 1 || 0;
      } catch (e) {
        console.error(e);
      }

      return r;
    });

    updater.signals.progress(p => {
      mainWindow.webContents.send('updater:download-progress', p.percent);
    });

    ipcMain.handle('updater:download', async () => {
      try {
        await updater.downloadUpdate();
        return true;
      } catch (e) {
        console.error(e);
        return false;
      }
    });

    ipcMain.on('updater:install', () => {
      updater.quitAndInstall(true, true);
    });

  } catch (err) {
    dialog.showErrorBox(`'Aw, snap!': The Animation`, err instanceof Error
      ? err.stack || err.message
      : 'Unknown error!');
    app.quit();
  }
});