const { contextBridge, ipcRenderer } = require('electron');

// 安全地暴露API给渲染进程
contextBridge.exposeInMainWorld('electronAPI', {
  // 配置管理
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  
  // 项目管理
  startProject: (projectId, commands, workingDir) => 
    ipcRenderer.invoke('start-project', projectId, commands, workingDir),
  stopProject: (projectId) => ipcRenderer.invoke('stop-project', projectId),
  
  // 文件/目录选择
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  exportConfig: () => ipcRenderer.invoke('export-config'),
  importConfig: () => ipcRenderer.invoke('import-config'),
  
  // PowerShell版本
  getPowerShellVersion: () => ipcRenderer.invoke('get-powershell-version'),
  
  // 事件监听
  onProjectOutput: (callback) => {
    ipcRenderer.on('project-output', (event, data) => callback(data));
  },
  onProjectExit: (callback) => {
    ipcRenderer.on('project-exit', (event, data) => callback(data));
  },
  onProjectError: (callback) => {
    ipcRenderer.on('project-error', (event, data) => callback(data));
  },
  onPowerShellVersion: (callback) => {
    ipcRenderer.on('powershell-version', (event, data) => callback(data));
  },
  
  // 移除监听器
  removeAllListeners: (channel) => {
    if (channel) {
      ipcRenderer.removeAllListeners(channel);
    } else {
      ipcRenderer.removeAllListeners('project-output');
      ipcRenderer.removeAllListeners('project-exit');
      ipcRenderer.removeAllListeners('project-error');
      ipcRenderer.removeAllListeners('powershell-version');
    }
  }
});

