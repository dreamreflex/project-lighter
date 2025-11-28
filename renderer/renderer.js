const { ipcRenderer } = require('electron');

let config = { projects: [] };
let projectStatuses = {}; // projectId -> 'running' | 'stopped'

// DOM 元素
const projectsContainer = document.getElementById('projectsContainer');
const emptyState = document.getElementById('emptyState');
const editConfigBtn = document.getElementById('editConfigBtn');
const refreshBtn = document.getElementById('refreshBtn');
const configModal = document.getElementById('configModal');
const closeModalBtn = document.getElementById('closeModalBtn');
const saveConfigBtn = document.getElementById('saveConfigBtn');
const cancelConfigBtn = document.getElementById('cancelConfigBtn');
const configTextarea = document.getElementById('configTextarea');
const addFirstProjectBtn = document.getElementById('addFirstProjectBtn');
const powershellVersionEl = document.getElementById('powershellVersion');

// 交互式配置相关元素
const addProjectBtn = document.getElementById('addProjectBtn');
const exportConfigBtn = document.getElementById('exportConfigBtn');
const importConfigBtn = document.getElementById('importConfigBtn');
const projectModal = document.getElementById('projectModal');
const closeProjectModalBtn = document.getElementById('closeProjectModalBtn');
const projectForm = document.getElementById('projectForm');
const projectNameInput = document.getElementById('projectName');
const projectWorkingDirInput = document.getElementById('projectWorkingDir');
const selectDirBtn = document.getElementById('selectDirBtn');
const commandsContainer = document.getElementById('commandsContainer');
const addCommandBtn = document.getElementById('addCommandBtn');
const saveProjectBtn = document.getElementById('saveProjectBtn');
const cancelProjectBtn = document.getElementById('cancelProjectBtn');
const projectModalTitle = document.getElementById('projectModalTitle');
const importFileInput = document.getElementById('importFileInput');

let editingProjectId = null; // 当前正在编辑的项目ID，null表示新建
let commandCounter = 0; // 命令计数器

// 加载配置
async function loadConfig() {
  try {
    config = await ipcRenderer.invoke('get-config');
    renderProjects();
  } catch (error) {
    console.error('加载配置失败:', error);
    showError('加载配置失败: ' + error.message);
  }
}

// 渲染项目列表
function renderProjects() {
  if (!config.projects || config.projects.length === 0) {
    projectsContainer.style.display = 'none';
    emptyState.style.display = 'block';
    return;
  }

  projectsContainer.style.display = 'grid';
  emptyState.style.display = 'none';

  projectsContainer.innerHTML = '';

  config.projects.forEach(project => {
    const projectCard = createProjectCard(project);
    projectsContainer.appendChild(projectCard);
  });
}

// 获取项目的命令列表（支持向后兼容）
function getProjectCommands(project) {
  if (project.commands && Array.isArray(project.commands)) {
    return project.commands;
  } else if (project.command) {
    // 向后兼容：单个命令转换为数组
    return [{ name: '主命令', command: project.command }];
  }
  return [];
}

// 创建项目卡片
function createProjectCard(project) {
  const card = document.createElement('div');
  card.className = 'project-card';
  card.id = `project-${project.id}`;

  const isRunning = projectStatuses[project.id] === 'running';
  const commands = getProjectCommands(project);
  const hasMultipleCommands = commands.length > 1;

  // 构建命令信息显示
  let commandsInfoHtml = '';
  if (hasMultipleCommands) {
    commands.forEach((cmd, index) => {
      commandsInfoHtml += `
        <div class="project-info-item">
          <span class="project-info-label">${escapeHtml(cmd.name || `命令 ${index + 1}`)}:</span>
          <span>${escapeHtml(cmd.command || '')}</span>
        </div>
      `;
    });
  } else if (commands.length === 1) {
    commandsInfoHtml = `
      <div class="project-info-item">
        <span class="project-info-label">命令:</span>
        <span>${escapeHtml(commands[0].command || '')}</span>
      </div>
    `;
  }

  // 构建输出区域（所有命令共享同一个输出区域）
  const outputHtml = `<div class="project-output" id="output-${project.id}"></div>`;

  card.innerHTML = `
    <div class="project-header">
      <div class="project-name">${escapeHtml(project.name || '未命名项目')}</div>
      <div class="project-status">
        <span class="status-indicator ${isRunning ? 'running' : 'stopped'}"></span>
        <span>${isRunning ? '运行中' : '已停止'}</span>
      </div>
    </div>
    <div class="project-body">
      <div class="project-info">
        ${commandsInfoHtml}
        <div class="project-info-item">
          <span class="project-info-label">工作目录:</span>
          <span>${escapeHtml(project.workingDir || '当前目录')}</span>
        </div>
      </div>
      <div class="project-actions">
        <button class="btn btn-primary start-btn" ${isRunning ? 'disabled' : ''} data-project-id="${project.id}">
          启动
        </button>
        <button class="btn btn-danger stop-btn" ${!isRunning ? 'disabled' : ''} data-project-id="${project.id}">
          停止
        </button>
        <button class="btn btn-secondary edit-project-btn" data-project-id="${project.id}">
          编辑
        </button>
        <button class="btn btn-secondary delete-project-btn" data-project-id="${project.id}">
          删除
        </button>
      </div>
      ${outputHtml}
    </div>
  `;

  // 绑定事件
  const startBtn = card.querySelector('.start-btn');
  const stopBtn = card.querySelector('.stop-btn');
  const editBtn = card.querySelector('.edit-project-btn');
  const deleteBtn = card.querySelector('.delete-project-btn');

  startBtn.addEventListener('click', () => startProject(project.id));
  stopBtn.addEventListener('click', () => stopProject(project.id));
  if (editBtn) {
    editBtn.addEventListener('click', () => openProjectModal(project.id));
  }
  if (deleteBtn) {
    deleteBtn.addEventListener('click', () => deleteProject(project.id));
  }

  return card;
}

// 启动项目
async function startProject(projectId) {
  const project = config.projects.find(p => p.id === projectId);
  if (!project) return;

  try {
    const commands = getProjectCommands(project);
    if (commands.length === 0) {
      showError('项目没有配置任何命令');
      return;
    }

    // 清空输出
    const outputEl = document.getElementById(`output-${projectId}`);
    if (outputEl) {
      outputEl.textContent = '';
      // 显示将要执行的命令序列
      const commandList = commands.map((cmd, index) => {
        const name = cmd.name || `步骤 ${index + 1}`;
        return `${index + 1}. [${name}] ${cmd.command}`;
      }).join('\n');
      outputEl.textContent = `准备在 PowerShell 中执行以下命令序列:\n${commandList}\n\n${'='.repeat(50)}\n\n`;
    }

    const result = await ipcRenderer.invoke('start-project', projectId, commands, project.workingDir);

    if (result.success) {
      projectStatuses[projectId] = 'running';
      updateProjectStatus(projectId);
    } else {
      showError(`启动项目失败: ${result.error || '未知错误'}`);
    }
  } catch (error) {
    showError(`启动项目失败: ${error.message}`);
  }
}

// 停止项目
async function stopProject(projectId) {
  try {
    const result = await ipcRenderer.invoke('stop-project', projectId);
    if (result) {
      projectStatuses[projectId] = 'stopped';
      updateProjectStatus(projectId);
    }
  } catch (error) {
    showError(`停止项目失败: ${error.message}`);
  }
}

// 更新项目状态
function updateProjectStatus(projectId) {
  const card = document.getElementById(`project-${projectId}`);
  if (!card) return;

  const isRunning = projectStatuses[projectId] === 'running';
  const statusIndicator = card.querySelector('.status-indicator');
  const statusText = card.querySelector('.project-status span:last-child');
  const startBtn = card.querySelector('.start-btn');
  const stopBtn = card.querySelector('.stop-btn');

  if (statusIndicator) {
    statusIndicator.className = `status-indicator ${isRunning ? 'running' : 'stopped'}`;
  }
  if (statusText) {
    statusText.textContent = isRunning ? '运行中' : '已停止';
  }
  if (startBtn) {
    startBtn.disabled = isRunning;
  }
  if (stopBtn) {
    stopBtn.disabled = !isRunning;
  }
}


// 显示错误信息
function showError(message) {
  alert(message);
}

// HTML 转义
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ANSI 转义序列转 HTML（使用状态机处理流式输出）
const ansiState = new Map(); // 存储每个输出区域的当前样式状态

function ansiToHtml(text, projectId) {
  // 获取或初始化该项目的样式状态
  if (!ansiState.has(projectId)) {
    ansiState.set(projectId, {
      bold: false,
      dim: false,
      italic: false,
      underline: false,
      fgColor: null,
      bgColor: null
    });
  }
  const currentStyles = ansiState.get(projectId);

  // ANSI 转义序列正则：\x1b[ 或 \u001b[ 或 \033[ 或 ESC[
  const ansiRegex = /[\u001b\u009b]\[([0-9;]*)([a-zA-Z])/g;

  const colorMap = {
    // 标准颜色
    30: '#000000', 31: '#cd3131', 32: '#0dbc79', 33: '#e5e510',
    34: '#2472c8', 35: '#bc3fbc', 36: '#11a8cd', 37: '#e5e5e5',
    // 亮色
    90: '#666666', 91: '#f14c4c', 92: '#23d18b', 93: '#f5f543',
    94: '#3b8eea', 95: '#d670d6', 96: '#29b8db', 97: '#e5e5e5',
    // 背景色
    40: '#000000', 41: '#cd3131', 42: '#0dbc79', 43: '#e5e510',
    44: '#2472c8', 45: '#bc3fbc', 46: '#11a8cd', 47: '#e5e5e5'
  };

  function resetStyles() {
    currentStyles.bold = false;
    currentStyles.dim = false;
    currentStyles.italic = false;
    currentStyles.underline = false;
    currentStyles.fgColor = null;
    currentStyles.bgColor = null;
  }

  function processAnsiCode(code) {
    if (!code) return;
    const codes = code.split(';').map(c => parseInt(c) || 0);

    for (const c of codes) {
      switch (c) {
        case 0: // 重置所有
          resetStyles();
          break;
        case 1: // 粗体
          currentStyles.bold = true;
          break;
        case 2: // 暗淡
          currentStyles.dim = true;
          break;
        case 3: // 斜体
          currentStyles.italic = true;
          break;
        case 4: // 下划线
          currentStyles.underline = true;
          break;
        case 22: // 取消粗体/暗淡
          currentStyles.bold = false;
          currentStyles.dim = false;
          break;
        case 23: // 取消斜体
          currentStyles.italic = false;
          break;
        case 24: // 取消下划线
          currentStyles.underline = false;
          break;
        case 39: // 重置前景色
          currentStyles.fgColor = null;
          break;
        case 49: // 重置背景色
          currentStyles.bgColor = null;
          break;
        default:
          // 前景色 30-37, 90-97
          if ((c >= 30 && c <= 37) || (c >= 90 && c <= 97)) {
            currentStyles.fgColor = colorMap[c] || null;
          }
          // 背景色 40-47
          else if (c >= 40 && c <= 47) {
            currentStyles.bgColor = colorMap[c] || null;
          }
          break;
      }
    }
  }

  function getStyleString() {
    const css = [];
    if (currentStyles.bold) css.push('font-weight: bold');
    if (currentStyles.dim) css.push('opacity: 0.5');
    if (currentStyles.italic) css.push('font-style: italic');
    if (currentStyles.underline) css.push('text-decoration: underline');
    if (currentStyles.fgColor) css.push(`color: ${currentStyles.fgColor}`);
    if (currentStyles.bgColor) css.push(`background-color: ${currentStyles.bgColor}`);
    return css.length > 0 ? css.join('; ') : null;
  }

  let html = '';
  let lastIndex = 0;
  let match;

  while ((match = ansiRegex.exec(text)) !== null) {
    // 添加转义序列之前的文本
    const beforeText = text.substring(lastIndex, match.index);
    if (beforeText) {
      const style = getStyleString();
      const escaped = escapeHtml(beforeText);
      html += style ? `<span style="${style}">${escaped}</span>` : escaped;
    }

    const code = match[1];
    const command = match[2];

    if (command === 'm') {
      // SGR 命令
      processAnsiCode(code);
    }

    lastIndex = match.index + match[0].length;
  }

  // 添加剩余的文本
  const remainingText = text.substring(lastIndex);
  if (remainingText) {
    const style = getStyleString();
    const escaped = escapeHtml(remainingText);
    html += style ? `<span style="${style}">${escaped}</span>` : escaped;
  }

  return html;
}

// 打开配置编辑模态框
function openConfigModal() {
  configTextarea.value = JSON.stringify(config, null, 2);
  configModal.classList.add('show');
}

// 关闭配置编辑模态框
function closeConfigModal() {
  configModal.classList.remove('show');
}

// 保存配置
async function saveConfig() {
  try {
    const configText = configTextarea.value.trim();
    const newConfig = JSON.parse(configText);

    // 验证配置格式
    if (!newConfig.projects || !Array.isArray(newConfig.projects)) {
      throw new Error('配置格式错误: projects 必须是数组');
    }

    // 验证每个项目
    newConfig.projects.forEach((project, index) => {
      if (!project.id) {
        throw new Error(`项目 ${index + 1} 缺少 id 字段`);
      }
      if (!project.name) {
        throw new Error(`项目 ${index + 1} 缺少 name 字段`);
      }
      // 支持 commands 数组或单个 command（向后兼容）
      if (!project.commands && !project.command) {
        throw new Error(`项目 ${index + 1} 缺少 command 或 commands 字段`);
      }
      if (project.commands && !Array.isArray(project.commands)) {
        throw new Error(`项目 ${index + 1} 的 commands 必须是数组`);
      }
      if (project.commands) {
        project.commands.forEach((cmd, cmdIndex) => {
          if (!cmd.command) {
            throw new Error(`项目 ${index + 1} 的命令 ${cmdIndex + 1} 缺少 command 字段`);
          }
        });
      }
    });

    const result = await ipcRenderer.invoke('save-config', newConfig);
    if (result) {
      config = newConfig;
      // 停止所有运行中的项目
      Object.keys(projectStatuses).forEach(projectId => {
        if (projectStatuses[projectId] === 'running') {
          stopProject(projectId);
        }
      });
      projectStatuses = {};
      renderProjects();
      closeConfigModal();
      alert('配置保存成功！');
    } else {
      throw new Error('保存配置失败');
    }
  } catch (error) {
    showError('保存配置失败: ' + error.message);
  }
}

// IPC 监听器
ipcRenderer.on('project-output', (event, data) => {
  const outputEl = document.getElementById(`output-${data.projectId}`);
  if (outputEl) {
    // 将 ANSI 转义序列转换为 HTML
    const html = ansiToHtml(data.data, data.projectId);

    // 使用 insertAdjacentHTML 来插入 HTML（保留样式）
    outputEl.insertAdjacentHTML('beforeend', html);

    // 自动滚动到底部
    outputEl.scrollTop = outputEl.scrollHeight;
  }
});

ipcRenderer.on('project-exit', (event, data) => {
  projectStatuses[data.projectId] = 'stopped';
  updateProjectStatus(data.projectId);

  const outputEl = document.getElementById(`output-${data.projectId}`);
  if (outputEl) {
    const exitText = document.createTextNode(`\n\n[进程已退出，退出码: ${data.code}]\n`);
    outputEl.appendChild(exitText);
    outputEl.scrollTop = outputEl.scrollHeight;
  }
});

ipcRenderer.on('project-error', (event, data) => {
  projectStatuses[data.projectId] = 'stopped';
  updateProjectStatus(data.projectId);

  const outputEl = document.getElementById(`output-${data.projectId}`);
  if (outputEl) {
    const errorSpan = document.createElement('span');
    errorSpan.style.color = '#f14c4c';
    errorSpan.textContent = `\n\n[错误: ${data.error}]\n`;
    outputEl.appendChild(errorSpan);
    outputEl.scrollTop = outputEl.scrollHeight;
  }

  showError(`项目 ${data.projectId} 发生错误: ${data.error}`);
});

// 创建命令项HTML
function createCommandItem(command = { name: '', command: '' }, index = 0) {
  const commandId = `command-${commandCounter++}`;
  const commandDiv = document.createElement('div');
  commandDiv.className = 'command-item';
  commandDiv.id = commandId;
  commandDiv.innerHTML = `
    <div class="command-item-header">
      <span class="command-item-title">命令 ${index + 1}</span>
      <div class="command-item-actions">
        <button type="button" class="btn btn-danger btn-sm remove-command-btn">删除</button>
      </div>
    </div>
    <div class="command-item-body">
      <div class="form-group">
        <label>命令名称</label>
        <input type="text" class="form-control command-name" value="${escapeHtml(command.name || '')}" placeholder="例如：启动服务">
      </div>
      <div class="form-group">
        <label>命令内容 *</label>
        <input type="text" class="form-control command-content" value="${escapeHtml(command.command || '')}" placeholder="例如：npm run dev" required>
      </div>
    </div>
  `;

  // 绑定删除按钮
  const removeBtn = commandDiv.querySelector('.remove-command-btn');
  removeBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    commandDiv.remove();
    updateCommandNumbers();
  });

  // 确保输入框可以正常交互
  const inputs = commandDiv.querySelectorAll('input');
  inputs.forEach(input => {
    input.disabled = false;
    input.readOnly = false;
  });

  return commandDiv;
}

// 更新命令编号
function updateCommandNumbers() {
  const commandItems = commandsContainer.querySelectorAll('.command-item');
  commandItems.forEach((item, index) => {
    const title = item.querySelector('.command-item-title');
    if (title) {
      title.textContent = `命令 ${index + 1}`;
    }
  });
}

// 打开项目编辑模态框
function openProjectModal(projectId = null) {
  editingProjectId = projectId;

  if (projectId) {
    // 编辑模式
    const project = config.projects.find(p => p.id === projectId);
    if (!project) return;

    projectModalTitle.textContent = '编辑项目';
    projectNameInput.value = project.name || '';
    projectWorkingDirInput.value = project.workingDir || '';

    // 清空命令容器
    commandsContainer.innerHTML = '';
    const commands = getProjectCommands(project);
    commands.forEach((cmd, index) => {
      const commandItem = createCommandItem(cmd, index);
      commandsContainer.appendChild(commandItem);
    });
  } else {
    // 新建模式
    projectModalTitle.textContent = '新建项目';
    projectForm.reset();
    commandsContainer.innerHTML = '';
    // 默认添加一个命令
    const commandItem = createCommandItem({ name: '', command: '' }, 0);
    commandsContainer.appendChild(commandItem);
  }

  // 显示模态框
  projectModal.classList.add('show');

  // Ensure focus is set correctly
  setTimeout(() => {
    if (projectNameInput) {
      projectNameInput.disabled = false;
      projectNameInput.focus();
      projectNameInput.select();
    }
    if (projectWorkingDirInput) {
      projectWorkingDirInput.disabled = false;
    }
  }, 100);
}

// 关闭项目编辑模态框
function closeProjectModal() {
  projectModal.classList.remove('show');
  editingProjectId = null;
  projectForm.reset();
  commandsContainer.innerHTML = '';
}

// 保存项目
async function saveProject() {
  if (!projectForm.checkValidity()) {
    projectForm.reportValidity();
    return;
  }

  const name = projectNameInput.value.trim();
  const workingDir = projectWorkingDirInput.value.trim();

  if (!name) {
    showError('请输入项目名称');
    return;
  }

  // 收集所有命令
  const commands = [];
  const commandItems = commandsContainer.querySelectorAll('.command-item');

  if (commandItems.length === 0) {
    showError('请至少添加一个命令');
    return;
  }

  for (const item of commandItems) {
    const commandName = item.querySelector('.command-name').value.trim();
    const commandContent = item.querySelector('.command-content').value.trim();

    if (!commandContent) {
      showError('请填写所有命令的内容');
      return;
    }

    commands.push({
      name: commandName || undefined,
      command: commandContent
    });
  }

  try {
    if (editingProjectId) {
      // 更新现有项目
      const projectIndex = config.projects.findIndex(p => p.id === editingProjectId);
      if (projectIndex !== -1) {
        config.projects[projectIndex] = {
          id: editingProjectId,
          name,
          commands: commands.length > 1 ? commands : undefined,
          command: commands.length === 1 ? commands[0].command : undefined,
          workingDir: workingDir || undefined
        };
      }
    } else {
      // 新建项目
      const newId = String(Date.now());
      const newProject = {
        id: newId,
        name,
        commands: commands.length > 1 ? commands : undefined,
        command: commands.length === 1 ? commands[0].command : undefined,
        workingDir: workingDir || undefined
      };
      config.projects.push(newProject);
    }

    // 保存配置
    const result = await ipcRenderer.invoke('save-config', config);
    if (result) {
      // 停止所有运行中的项目
      Object.keys(projectStatuses).forEach(projectId => {
        if (projectStatuses[projectId] === 'running') {
          stopProject(projectId);
        }
      });
      projectStatuses = {};

      renderProjects();
      closeProjectModal();
      alert('项目保存成功！');
    } else {
      showError('保存项目失败');
    }
  } catch (error) {
    showError('保存项目失败: ' + error.message);
  }
}

// 删除项目
async function deleteProject(projectId) {
  if (!confirm('确定要删除这个项目吗？')) {
    return;
  }

  // 如果项目正在运行，先停止
  if (projectStatuses[projectId] === 'running') {
    await stopProject(projectId);
  }

  config.projects = config.projects.filter(p => p.id !== projectId);

  try {
    const result = await ipcRenderer.invoke('save-config', config);
    if (result) {
      renderProjects();
      alert('项目已删除');
    } else {
      showError('删除项目失败');
    }
  } catch (error) {
    showError('删除项目失败: ' + error.message);
  }
}

// 导出配置
async function exportConfig() {
  try {
    const result = await ipcRenderer.invoke('export-config');
    if (result.success) {
      alert(`配置已导出到: ${result.path}`);
    }
  } catch (error) {
    showError('导出配置失败: ' + error.message);
  }
}

// 导入配置
async function importConfig() {
  try {
    const result = await ipcRenderer.invoke('import-config');
    if (result.success) {
      if (confirm('导入配置将覆盖当前配置，是否继续？')) {
        // 停止所有运行中的项目
        Object.keys(projectStatuses).forEach(projectId => {
          if (projectStatuses[projectId] === 'running') {
            stopProject(projectId);
          }
        });
        projectStatuses = {};

        config = result.config;
        const saveResult = await ipcRenderer.invoke('save-config', config);
        if (saveResult) {
          renderProjects();
          alert('配置导入成功！');
        } else {
          showError('保存导入的配置失败');
        }
      }
    } else if (result.error) {
      showError('导入配置失败: ' + result.error);
    }
  } catch (error) {
    showError('导入配置失败: ' + error.message);
  }
}

// 事件监听
editConfigBtn.addEventListener('click', openConfigModal);
refreshBtn.addEventListener('click', loadConfig);
closeModalBtn.addEventListener('click', closeConfigModal);
cancelConfigBtn.addEventListener('click', closeConfigModal);
saveConfigBtn.addEventListener('click', saveConfig);
addFirstProjectBtn.addEventListener('click', () => openProjectModal());

// 交互式配置事件
addProjectBtn.addEventListener('click', () => openProjectModal());
closeProjectModalBtn.addEventListener('click', closeProjectModal);
cancelProjectBtn.addEventListener('click', closeProjectModal);
saveProjectBtn.addEventListener('click', saveProject);
addCommandBtn.addEventListener('click', () => {
  const commandItem = createCommandItem({ name: '', command: '' }, commandsContainer.children.length);
  commandsContainer.appendChild(commandItem);
  updateCommandNumbers();
});
selectDirBtn.addEventListener('click', async () => {
  const dir = await ipcRenderer.invoke('select-directory');
  if (dir) {
    projectWorkingDirInput.value = dir;
  }
});
exportConfigBtn.addEventListener('click', exportConfig);
importConfigBtn.addEventListener('click', importConfig);

// 点击模态框外部关闭
configModal.addEventListener('click', (e) => {
  if (e.target === configModal) {
    closeConfigModal();
  }
});

projectModal.addEventListener('click', (e) => {
  if (e.target === projectModal) {
    closeProjectModal();
  }
});

// 显示 PowerShell 版本信息
ipcRenderer.on('powershell-version', (event, versionInfo) => {
  if (versionInfo && versionInfo.success) {
    powershellVersionEl.textContent = `PowerShell ${versionInfo.version} (${versionInfo.edition})`;
    powershellVersionEl.title = `PowerShell 版本: ${versionInfo.version}\n版本类型: ${versionInfo.edition}`;
  } else {
    powershellVersionEl.textContent = 'PowerShell 版本: 无法获取';
    powershellVersionEl.style.color = '#dc3545';
  }
});

// 初始化时也尝试获取版本（如果主进程已经获取）
ipcRenderer.invoke('get-powershell-version').then(versionInfo => {
  if (versionInfo) {
    if (versionInfo.success) {
      powershellVersionEl.textContent = `PowerShell ${versionInfo.version} (${versionInfo.edition})`;
      powershellVersionEl.title = `PowerShell 版本: ${versionInfo.version}\n版本类型: ${versionInfo.edition}`;
    } else {
      powershellVersionEl.textContent = 'PowerShell 版本: 无法获取';
      powershellVersionEl.style.color = '#dc3545';
    }
  }
});

// 初始化
loadConfig();

