const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

let mainWindow;
const runningProcesses = new Map(); // key: projectId, value: childProcess
const outputBuffers = new Map(); // key: projectId, value: { stdout: Buffer, stderr: Buffer }
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

// 获取应用图标路径
function getIconPath() {
  // Windows 优先使用 .ico 文件
  if (process.platform === 'win32') {
    const icoPath = path.join(__dirname, 'logo.ico');
    if (fs.existsSync(icoPath)) {
      return icoPath;
    }
  }
  
  // 其他平台或 Windows 没有 .ico 时使用 .png
  const pngPath = path.join(__dirname, 'logo.png');
  if (fs.existsSync(pngPath)) {
    return pngPath;
  }
  
  // 如果都不存在，返回 null（使用默认图标）
  return null;
}

// 创建窗口
async function createWindow() {
  // 在创建窗口前获取 PowerShell 版本
  powershellVersion = await getPowerShellVersion();

  // 获取图标路径
  const iconPath = getIconPath();
  
  const windowOptions = {
    width: 1200,
    height: 800,
    autoHideMenuBar: true, // 自动隐藏菜单栏
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  };
  
  // 如果图标存在，添加到窗口选项
  if (iconPath) {
    windowOptions.icon = iconPath;
  }
  
  mainWindow = new BrowserWindow(windowOptions);
  
  // 移除窗口菜单栏
  mainWindow.setMenuBarVisibility(false);
  
  // 确保设置任务栏图标（Windows）
  if (process.platform === 'win32' && iconPath) {
    mainWindow.setIcon(iconPath);
  }

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
      
      // 设置完整的 UTF-8 编码环境
      // 包括：控制台输出编码、输入编码、默认编码
      const encodingSetup = `
        [Console]::OutputEncoding = [System.Text.Encoding]::UTF8;
        [Console]::InputEncoding = [System.Text.Encoding]::UTF8;
        $OutputEncoding = [System.Text.Encoding]::UTF8;
        [System.Console]::OutputEncoding = [System.Text.Encoding]::UTF8;
        $env:PYTHONIOENCODING = 'utf-8';
        chcp 65001 | Out-Null;
      `;
      
      const args = [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `${encodingSetup} ${combinedCommand}`
      ];

      const childProcess = spawn(shellCommand, args, {
        cwd: workingDir || process.cwd(),
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
          LANG: 'en_US.UTF-8'
        }
      });

      // 存储进程（使用 projectId 作为 key）
      runningProcesses.set(projectId, childProcess);
      
      // 初始化输出缓冲区
      if (!outputBuffers.has(projectId)) {
        outputBuffers.set(projectId, { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
      }

      // 安全地将 Buffer 转换为 UTF-8 字符串
      function safeBufferToString(buffer) {
        if (!buffer || buffer.length === 0) return '';
        
        try {
          // 确保是 Buffer
          const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
          // 使用 UTF-8 编码，并允许替换无效字符
          return buf.toString('utf8');
        } catch (error) {
          try {
            // 如果失败，尝试使用容错模式
            const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
            return buf.toString('utf8', 'replace');
          } catch (e) {
            return '[编码错误]';
          }
        }
      }

      // 处理输出数据，处理不完整的 UTF-8 字符
      function processOutput(projectId, data, type) {
        if (!data || (Buffer.isBuffer(data) && data.length === 0)) return;
        
        const buffers = outputBuffers.get(projectId);
        if (!buffers) return;
        
        // 将新数据添加到缓冲区
        const newData = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
        buffers[type] = Buffer.concat([buffers[type], newData]);
        
        // 尝试解码完整的内容
        let decoded = '';
        let remaining = Buffer.alloc(0);
        
        const buf = buffers[type];
        if (buf.length === 0) return;
        
        // 从后往前查找完整的 UTF-8 字符边界
        let validLength = buf.length;
        for (let i = buf.length - 1; i >= Math.max(0, buf.length - 4); i--) {
          const byte = buf[i];
          // UTF-8 起始字节的特征
          if ((byte & 0x80) === 0) {
            // ASCII 字符或完整的多字节字符的最后一个字节
            validLength = i + 1;
            break;
          } else if ((byte & 0xC0) === 0xC0) {
            // 可能是多字节字符的起始字节，保留之前的字节
            validLength = i;
            break;
          }
        }
        
        if (validLength > 0) {
          // 解码完整的部分
          try {
            decoded = buf.slice(0, validLength).toString('utf8');
            remaining = buf.slice(validLength);
            buffers[type] = remaining;
          } catch (error) {
            // 如果解码失败，尝试使用容错模式
            try {
              decoded = buf.slice(0, validLength).toString('utf8', 'replace');
              remaining = buf.slice(validLength);
              buffers[type] = remaining;
            } catch (e) {
              // 如果还是失败，清空缓冲区并跳过这段数据
              buffers[type] = Buffer.alloc(0);
              decoded = '[解码错误]';
            }
          }
          
          // 发送解码后的数据
          if (decoded && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('project-output', {
              projectId,
              type: type,
              data: decoded
            });
          }
        }
      }

      // 处理输出
      childProcess.stdout.on('data', (data) => {
        processOutput(projectId, data, 'stdout');
      });

      childProcess.stderr.on('data', (data) => {
        processOutput(projectId, data, 'stderr');
      });
      
      // 进程退出时，发送剩余的缓冲区数据
      childProcess.on('exit', (code) => {
        const buffers = outputBuffers.get(projectId);
        if (buffers) {
          // 发送剩余的 stdout 数据
          if (buffers.stdout.length > 0 && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('project-output', {
              projectId,
              type: 'stdout',
              data: safeBufferToString(buffers.stdout)
            });
          }
          // 发送剩余的 stderr 数据
          if (buffers.stderr.length > 0 && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('project-output', {
              projectId,
              type: 'stderr',
              data: safeBufferToString(buffers.stderr)
            });
          }
          outputBuffers.delete(projectId);
        }
        
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

// 打开外部链接
ipcMain.handle('open-external', async (event, url) => {
  try {
    await shell.openExternal(url);
    return { success: true };
  } catch (error) {
    console.error('打开外部链接失败:', error);
    return { success: false, error: error.message };
  }
});

// 禁用硬件加速以防止 GPU 进程崩溃
app.disableHardwareAcceleration();

// 移除菜单栏 - 创建空菜单
function createEmptyMenu() {
  const menu = Menu.buildFromTemplate([]);
  Menu.setApplicationMenu(menu);
}

// 应用生命周期
app.whenReady().then(() => {
  // 移除应用菜单栏
  createEmptyMenu();
  
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

