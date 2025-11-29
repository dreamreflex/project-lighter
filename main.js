const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

let mainWindow;
const runningProcesses = new Map(); // key: projectId, value: childProcess
let powershellVersion = null;

// 获取配置文件路径
function getConfigPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

// 读取配置文件
function readConfig() {
  try {
    const configPath = getConfigPath();
    if (fs.existsSync(configPath)) {
      const data = fs.readFileSync(configPath, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('读取配置文件失败:', error);
  }
  // 返回默认配置
  return {
    projects: []
  };
}

// 保存配置文件
function saveConfig(config) {
  try {
    const configPath = getConfigPath();
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error('保存配置文件失败:', error);
    return false;
  }
}

// 获取 PowerShell 版本信息
function getPowerShellVersion() {
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', ['-Command', '$PSVersionTable.PSVersion.ToString(); $PSVersionTable.PSEdition']);
    let output = '';
    let errorOutput = '';

    ps.stdout.on('data', (data) => {
      output += data.toString();
    });

    ps.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    ps.on('close', (code) => {
      if (code === 0 && output) {
        const lines = output.trim().split('\n');
        const version = lines[0] || '未知';
        const edition = lines[1] || '未知';
        resolve({ version, edition, success: true });
      } else {
        resolve({ version: '未知', edition: '未知', success: false, error: errorOutput });
      }
    });

    ps.on('error', () => {
      resolve({ version: '无法获取', edition: '无法获取', success: false });
    });
  });
}

// 创建窗口
async function createWindow() {
  // 在创建窗口前获取 PowerShell 版本
  powershellVersion = await getPowerShellVersion();

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.loadFile('renderer/index.html');

  // 等待页面加载完成后发送版本信息
  mainWindow.webContents.once('did-finish-load', () => {
    if (powershellVersion) {
      mainWindow.webContents.send('powershell-version', powershellVersion);
    }
  });

  // 开发时打开开发者工具
  // mainWindow.webContents.openDevTools();
}

// 启动项目（支持多条命令，按顺序在同一个PowerShell中执行）
function startProject(projectId, commands, workingDir) {
  return new Promise((resolve, reject) => {
    try {
      // 构建 PowerShell 命令
      // 使用条件执行：如果前一个命令成功（$? 为 $true），才执行下一个
      // 格式：command1; if ($?) { command2 }; if ($?) { command3 }
      let combinedCommand = '';
      for (let i = 0; i < commands.length; i++) {
        if (i === 0) {
          combinedCommand = commands[i].command;
        } else {
          combinedCommand += `; if ($?) { ${commands[i].command} }`;
        }
      }

      // 使用 PowerShell
      const shellCommand = 'powershell.exe';
      // Force UTF-8 encoding for the session
      const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${combinedCommand}`];

      const childProcess = spawn(shellCommand, args, {
        cwd: workingDir || process.cwd(),
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      // 存储进程（使用 projectId 作为 key）
      runningProcesses.set(projectId, childProcess);

      // 处理输出
      childProcess.stdout.on('data', (data) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('project-output', {
            projectId,
            type: 'stdout',
            data: data.toString()
          });
        }
      });

      childProcess.stderr.on('data', (data) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('project-output', {
            projectId,
            type: 'stderr',
            data: data.toString()
          });
        }
      });

      // 处理进程退出
      childProcess.on('exit', (code) => {
        runningProcesses.delete(projectId);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('project-exit', {
            projectId,
            code
          });
        }
      });

      childProcess.on('error', (error) => {
        runningProcesses.delete(projectId);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('project-error', {
            projectId,
            error: error.message
          });
        }
        reject(error);
      });

      resolve(childProcess);
    } catch (error) {
      reject(error);
    }
  });
}

// 停止项目
function stopProject(projectId) {
  const childProcess = runningProcesses.get(projectId);
  if (childProcess) {
    // Windows 需要终止进程树
    spawn('taskkill', ['/pid', childProcess.pid, '/f', '/t']);
    runningProcesses.delete(projectId);
    return true;
  }
  return false;
}

// IPC 处理程序
ipcMain.handle('get-config', () => {
  return readConfig();
});

ipcMain.handle('save-config', (event, config) => {
  return saveConfig(config);
});

ipcMain.handle('start-project', async (event, projectId, commands, workingDir) => {
  try {
    await startProject(projectId, commands, workingDir);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('stop-project', (event, projectId) => {
  return stopProject(projectId);
});

ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

ipcMain.handle('export-config', async () => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '导出配置',
    defaultPath: 'project-config.json',
    filters: [
      { name: 'JSON文件', extensions: ['json'] }
    ]
  });
  if (!result.canceled && result.filePath) {
    const config = readConfig();
    fs.writeFileSync(result.filePath, JSON.stringify(config, null, 2), 'utf8');
    return { success: true, path: result.filePath };
  }
  return { success: false };
});

ipcMain.handle('import-config', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '导入配置',
    filters: [
      { name: 'JSON文件', extensions: ['json'] }
    ],
    properties: ['openFile']
  });
  if (!result.canceled && result.filePaths.length > 0) {
    try {
      const data = fs.readFileSync(result.filePaths[0], 'utf8');
      const importedConfig = JSON.parse(data);
      return { success: true, config: importedConfig };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  return { success: false };
});

ipcMain.handle('get-powershell-version', () => {
  return powershellVersion;
});

// 禁用硬件加速以防止 GPU 进程崩溃
app.disableHardwareAcceleration();

// 应用生命周期
app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // 关闭所有运行中的进程
  runningProcesses.forEach((process, projectId) => {
    stopProject(projectId);
  });

  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  // 确保所有进程都被终止
  runningProcesses.forEach((process, projectId) => {
    stopProject(projectId);
  });
});

