<template>
  <div class="sftp_v2_container">
    <!-- 连接状态显示 -->
    <div v-if="connectionStatus !== 'connected'" class="connection_status">
      <div v-if="connectionStatus === 'connecting'" class="status_connecting">
        <el-icon class="is-loading"><Loading /></el-icon>
        <span>正在连接 SFTP...</span>
      </div>
      <div v-else-if="connectionStatus === 'reconnecting'" class="status_reconnecting">
        <el-icon class="is-loading"><Loading /></el-icon>
        <span>重新连接中...</span>
      </div>
      <div v-else-if="connectionStatus === 'failed'" class="status_failed">
        <el-icon class="error_icon"><WarningFilled /></el-icon>
        <div class="error_content">
          <h3>SFTP连接失败</h3>
          <p>{{ connectionError || '请检查服务端状态或网络连接' }}</p>
          <el-button type="primary" size="small" @click="connectSftp">重新连接</el-button>
        </div>
      </div>
    </div>

    <!-- 正常内容区域（连接成功时显示） -->
    <template v-if="connectionStatus === 'connected'">
      <!-- 工具栏：上传 / 新建 / 压缩 -->
      <div class="tool_bar">
        <!-- 上传 -->
        <el-dropdown trigger="click">
          <el-button type="" size="small">
            上传 <el-icon><ArrowDown /></el-icon>
          </el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item @click="handleUpload('file')">上传文件</el-dropdown-item>
              <el-dropdown-item @click="handleUpload('folder')">上传文件夹</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>

        <!-- 新建 -->
        <el-dropdown trigger="click">
          <el-button ref="newBtnRef" size="small">
            新建 <el-icon><ArrowDown /></el-icon>
          </el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item @click="handleNew('file')">新建文件</el-dropdown-item>
              <el-dropdown-item @click="handleNew('folder')">新建文件夹</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>

        <!-- 收藏 -->
        <el-dropdown trigger="click">
          <el-button type="" size="small">
            收藏 <el-icon><ArrowDown /></el-icon>
          </el-button>
          <template #dropdown>
            <el-dropdown-menu>
            <!-- <el-dropdown-item @click="handleUpload('file')">收藏文件</el-dropdown-item>
            <el-dropdown-item @click="handleUpload('folder')">收藏文件夹</el-dropdown-item> -->
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>

      <!-- 路径栏：当前路径 + 操作按钮 -->
      <div class="path_bar">
        <el-icon class="action_icon" @click="goParent"><ArrowLeft /></el-icon>
        <template v-if="!isEditingPath">
          <div ref="breadcrumbRef" class="breadcrumb_wrap">
            <span
              v-for="(seg, idx) in breadcrumb"
              :key="idx"
              class="breadcrumb_seg"
              @click="handleBreadcrumb(idx)"
            >
              <template v-if="idx!==0">
                <ArrowRight class="separator" />
              </template>
              <span v-if="idx===0"><HomeFilled /></span>
              <span v-else>{{ seg }}</span>
            </span>
          </div>
        </template>
        <template v-else>
          <el-input
            v-model="pathInput"
            size="small"
            class="path_input"
            @keyup.enter="confirmPathInput"
            @blur="cancelEditPath"
          />
        </template>
        <el-icon class="action_icon" title="编辑路径" @click="toggleEditPath"><Edit /></el-icon>
        <el-icon class="action_icon" title="复制当前路径" @click="copyCurrentPath"><DocumentCopy /></el-icon>
        <el-icon class="action_icon" title="刷新" @click="refresh"><Refresh /></el-icon>
        <el-icon class="action_icon" :title="showHidden ? '隐藏隐藏文件' : '显示隐藏文件'" @click="toggleHidden">
          <View v-if="showHidden" />
          <Hide v-else />
        </el-icon>
        <el-icon
          v-if="hasDownloadTasks"
          class="action_icon download_icon"
          :title="`下载管理 - 正在下载 ${activeDownloadTasks.length} 个任务`"
          @click="showDownloadManager"
        >
          <Download />
        </el-icon>
      </div>

      <!-- 文件列表 -->
      <el-table
        ref="tableRef"
        v-loading="loading"
        :data="fileList"
        height="100%"
        size="small"
        :default-sort="{ prop: 'name' }"
        class="file_table"
        element-loading-text="loading..."
        @row-click="onRowClick"
        @row-contextmenu="onRowContextMenu"
        @selection-change="onSelectionChange"
      >
        <el-table-column type="selection" width="32" />
        <el-table-column
          label="名称"
          width="auto"
          max-width="200"
          show-overflow-tooltip
        >
          <template #default="{ row }">
            <div class="file_name_cell">
              <img :src="getIcon(row.type)" class="file_icon">
              <template v-if="isEditing(row)">
                <el-input
                  v-model="editingName"
                  size="small"
                  class="rename_input"
                  @keyup.enter.stop="confirmRename(row)"
                  @keyup.esc.stop="cancelRename"
                />
                <el-icon class="rename_icon" @click.stop="confirmRename(row)"><Check /></el-icon>
                <el-icon class="rename_icon" @click.stop="cancelRename"><CloseIcon /></el-icon>
              </template>
              <template v-else>
                <span class="file_name" v-text="row.name" />
              </template>
            </div>
          </template>
        </el-table-column>
        <el-table-column
          prop="size"
          label="大小"
          :formatter="sizeFormatter"
          width="70"
        />
        <el-table-column
          prop="modifyTime"
          label="修改时间"
          width="80"
          :formatter="timeFormatter"
        />
      <!-- 权限列已隐藏，根据需求可再启用 -->
      </el-table>

      <!-- 新建文件/文件夹 Popover（虚拟触发） -->
      <el-popover
        v-model:visible="showCreatePopover"
        :virtual-ref="createPopoverRef"
        width="260"
        trigger="manual"
        placement="bottom-start"
        popper-class="sftp_create_popover"
      >
        <template #default>
          <el-input
            ref="createInputRef"
            v-model="createName"
            size="small"
            :placeholder="createType === 'folder' ? '输入文件夹名称' : '输入文件名称'"
            @keyup.enter="confirmCreate"
          />
          <div class="sftp_popover_actions">
            <el-button size="small" @click="showCreatePopover = false">取消</el-button>
            <el-button size="small" type="primary" @click="confirmCreate">确认</el-button>
          </div>
        </template>
      </el-popover>

      <!-- 下载任务管理对话框 -->
      <el-dialog
        v-model="showDownloadDialog"
        title="下载管理"
        width="600px"
        :close-on-click-modal="true"
      >
        <el-alert type="success" :closable="false" style="margin-bottom: 16px;">
          <template #title>
            <p style="font-size: 12px;"> 下列文件只在本次会话保留,连接断开后自动清理 </p>
          </template>
        </el-alert>
        <div class="download_manager_container">
          <!-- 正在下载的任务 -->
          <div v-if="activeDownloadTasks.length > 0" class="download_section">
            <h4 class="section_title">正在下载 ({{ activeDownloadTasks.length }})</h4>
            <div class="download_task_list">
              <div
                v-for="task in activeDownloadTasks"
                :key="task.taskId"
                class="download_task_item"
              >
                <div class="task_header">
                  <div class="file_info">
                    <el-icon class="file_icon"><Download /></el-icon>
                    <span class="file_name">{{ task.fileName }}</span>
                  </div>
                  <el-button
                    size="small"
                    type="danger"
                    @click="cancelDownload(task.taskId)"
                  >
                    取消
                  </el-button>
                </div>

                <div class="progress_info">
                  <el-progress
                    :percentage="task.progress"
                    :show-text="false"
                    :stroke-width="6"
                    status="success"
                  />
                  <div class="progress_details">
                    <span class="progress_text">
                      {{ formatSize(task.downloadedSize) }} / {{ formatSize(task.totalSize) }}
                      ({{ task.progress.toFixed(1) }}%)
                    </span>
                    <span class="speed_text">
                      {{ formatSpeed(task.speed) }} · {{ formatTime(task.eta) }}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- 已完成的任务 -->
          <div v-if="completedDownloadTasks.length > 0" class="download_section">
            <h4 class="section_title">已完成 ({{ completedDownloadTasks.length }})</h4>
            <div class="download_task_list">
              <div
                v-for="task in completedDownloadTasks"
                :key="task.taskId"
                class="download_task_item completed"
              >
                <div class="task_header">
                  <div class="file_info">
                    <el-icon class="file_icon success"><Check /></el-icon>
                    <span class="file_name">{{ task.fileName }}</span>
                  </div>
                  <div class="task_actions">
                    <el-button
                      size="small"
                      type="primary"
                      @click="downloadFile(task)"
                    >
                      下载
                    </el-button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- 无任务时的提示 -->
          <div v-if="!hasDownloadTasks" class="no_tasks">
            <el-icon class="empty_icon"><Download /></el-icon>
            <p>暂无下载任务</p>
          </div>
        </div>

        <template #footer>
          <el-button @click="showDownloadDialog = false">关闭</el-button>
        </template>
      </el-dialog>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch, getCurrentInstance, nextTick } from 'vue'
import { ArrowDown, ArrowLeft, Refresh, View, Hide, Edit, ArrowRight, HomeFilled, Check, Close as CloseIcon, Download, DocumentCopy, Loading, WarningFilled } from '@element-plus/icons-vue'
import socketIo from 'socket.io-client'
import dirIcon from '@/assets/image/system/dir.png'
import linkIcon from '@/assets/image/system/link.png'
import fileIcon from '@/assets/image/system/file.png'
import unknowIcon from '@/assets/image/system/unknow.png'
import { useContextMenu } from '@/composables/useContextMenu'

const props = defineProps({
  hostId: {
    type: String,
    required: true
  }
})

// 组件实例上下文
const { proxy: { $store, $message, $notification, $serviceURI, $messageBox } } = getCurrentInstance()

// 路径 & 隐藏文件显示
const currentPath = ref('/')
const SHOW_HIDDEN_KEY = 'easynode_show_hidden_files'
const showHidden = ref(JSON.parse(localStorage.getItem(SHOW_HIDDEN_KEY) ?? 'true'))
watch(showHidden, (val) => {
  localStorage.setItem(SHOW_HIDDEN_KEY, JSON.stringify(val))
  refresh()
})

// Socket & 列表
const socket = ref(null)
const token = computed(() => $store.token)
const loading = ref(false)

// 连接状态管理
const connectionStatus = ref('connecting') // connecting, connected, failed, reconnecting
const connectionError = ref('')

const fileListRaw = ref([])

function getRank(item) {
  const isHidden = item.name.startsWith('.')
  const isDir = item.type === 'd'
  const isLink = item.type === 'l'
  if (isHidden && isDir) return 0 // hidden dir
  if (isDir && item.name === 'root') return 1 // root directory special
  if (isHidden) return 2 // hidden file
  if (isDir) return 3 // visible dir
  if (isLink) return 4 // link
  return 5 // regular file
}

const fileList = computed(() => {
  const base = showHidden.value ? fileListRaw.value.slice() : fileListRaw.value.filter(it => !it.name.startsWith('.'))
  return base.sort((a, b) => {
    const r = getRank(a) - getRank(b)
    if (r !== 0) return r
    return a.name.localeCompare(b.name)
  })
})
const selectedRows = ref([])
const tableRef = ref(null)

// 上传 & 新建 (Popover)
const showCreatePopover = ref(false)
const createType = ref('folder') // 'folder' | 'file'
const createName = ref('')
const createPopoverRef = ref(null) // 固定参照元素 (新建按钮)
const newBtnRef = ref(null)
const createInputRef = ref(null)

// 上下文菜单
const { showMenu } = useContextMenu()

// 下载相关状态
const showDownloadDialog = ref(false)
const downloadTasks = ref(new Map()) // taskId -> 下载任务信息

// 计算属性：是否有下载任务
const hasDownloadTasks = computed(() => downloadTasks.value.size > 0)

// 计算属性：正在进行的下载任务列表
const activeDownloadTasks = computed(() => {
  return Array.from(downloadTasks.value.values()).filter(task => task.status === 'downloading')
})

// 计算属性：已完成的下载任务列表
const completedDownloadTasks = computed(() => {
  return Array.from(downloadTasks.value.values()).filter(task => task.status === 'completed')
})

//----------------------------------
// 初始化
//----------------------------------
onMounted(() => {
  connectSftp()
  nextTick(() => {
    createPopoverRef.value = newBtnRef.value
  })
})

onUnmounted(() => {
  if (socket.value) {
    socket.value.removeAllListeners()
    socket.value.close()
    socket.value = null
  }
})

//----------------------------------
// Socket 连接 & 目录操作
//----------------------------------

const connectSftp = () => {
  const { io } = socketIo

  // 清理旧的socket连接
  if (socket.value) {
    socket.value.removeAllListeners()
    socket.value.close()
    socket.value = null
  }

  connectionStatus.value = connectionStatus.value === 'connected' ? 'reconnecting' : 'connecting'
  connectionError.value = ''
  loading.value = true

  socket.value = io($serviceURI, {
    path: '/sftp-v2',
    forceNew: true,
    reconnectionAttempts: 0 // 禁用socket.io自带的重连，我们自己控制
  })

  socket.value.on('connect', () => {
    socket.value.emit('ws_sftp', { hostId: props.hostId, token: token.value })

    socket.value.on('connect_success', ({ rootList }) => {
      fileListRaw.value = rootList
      currentPath.value = '/'
      connectionStatus.value = 'connected'
      loading.value = false
    })

    socket.value.on('connect_fail', (msg) => {
      connectionStatus.value = 'failed'
      connectionError.value = msg
      loading.value = false
    })

    socket.value.on('dir_ls', (dirLs, path) => {
      fileListRaw.value = dirLs
      loading.value = false
      if (path) currentPath.value = path
      currentPath.value = path || currentPath.value
    })

    socket.value.on('not_exists_dir', (msg) => {
      if (msg) $message.warning(msg)
      loading.value = false
    })

    socket.value.on('rename_success', () => {
      $message.success('重命名成功')
      loading.value = false
      cancelRename()
    })

    socket.value.on('rename_fail', (msg) => {
      $message.error(`重命名失败: ${ msg }`)
      loading.value = false
      cancelRename()
    })

    socket.value.on('delete_success', () => {
      $message.success('删除成功')
      loading.value = false
    })

    socket.value.on('delete_fail', (msg) => {
      $message.error(`删除失败: ${ msg }`)
      loading.value = false
    })

    socket.value.on('move_success', () => {
      $message.success('移动成功')
      loading.value = false
    })

    socket.value.on('move_fail', (msg) => {
      $message.error(`移动失败: ${ msg }`)
      loading.value = false
    })

    socket.value.on('copy_success', () => {
      $message.success('复制成功')
      loading.value = false
    })

    socket.value.on('copy_fail', (msg) => {
      $message.error(`复制失败: ${ msg }`)
      loading.value = false
    })

    socket.value.on('create_success', (msg) => {
      $message.success(msg || '创建成功')
      loading.value = false
      refresh()
    })

    socket.value.on('create_fail', (msg) => {
      $message.error(`创建失败: ${ msg }`)
      loading.value = false
    })

    socket.value.on('compress_success', (msg) => {
      $message.success(msg || '压缩成功')
      loading.value = false
      refresh()
    })

    socket.value.on('compress_fail', (msg) => {
      $message.error(`压缩失败: ${ msg }`)
      loading.value = false
    })

    socket.value.on('decompress_success', (msg) => {
      $message.success(msg || '解压成功')
      loading.value = false
      refresh()
    })

    socket.value.on('decompress_fail', (msg) => {
      $message.error(`解压失败: ${ msg }`)
      loading.value = false
    })

    // 下载相关事件
    socket.value.on('download_started', ({ taskId, fileName }) => {
      const newTask = {
        taskId,
        fileName,
        progress: 0,
        downloadedSize: 0,
        totalSize: 0,
        speed: 0,
        eta: 0,
        status: 'downloading',
        startTime: Date.now()
      }
      downloadTasks.value.set(taskId, newTask)
      loading.value = false
      showDownloadDialog.value = true
    })

    socket.value.on('download_progress', ({ taskId, progress, downloadedSize, totalSize, speed, eta }) => {
      const task = downloadTasks.value.get(taskId)
      if (task) {
        task.progress = progress
        task.downloadedSize = downloadedSize
        task.totalSize = totalSize
        task.speed = speed
        task.eta = eta
      }
    })

    socket.value.on('download_ready', ({ taskId, fileName }) => {
      const task = downloadTasks.value.get(taskId)
      if (task) {
        task.status = 'completed'
        task.progress = 100
        task.downloadUrl = `/sftp-cache/${ taskId }/${ encodeURIComponent(fileName) }`
        downloadFile(task)
      }
    })

    socket.value.on('download_fail', (msg) => {
      $message.error(`下载失败: ${ msg }`)
      loading.value = false
      // 清理失败的任务
      for (const [taskId, task,] of downloadTasks.value) {
        if (task.status === 'downloading') {
          downloadTasks.value.delete(taskId)
          break
        }
      }
    })

    socket.value.on('download_cancelled', ({ taskId }) => {
      downloadTasks.value.delete(taskId)
    })

    // SSH连接错误处理
    socket.value.on('shell_connection_error', ({ message, code }) => {
      console.error('SFTP连接shell终端错误：', message, 'Code:', code)
      connectionStatus.value = 'failed'
      connectionError.value = message
      loading.value = false
    })
  })

  // 添加断开连接监听，实现自动重连
  socket.value.on('disconnect', (reason) => {
    console.warn('SFTP连接断开:', reason)
    if (connectionStatus.value === 'connected') {
      // 只有在之前连接成功的情况下才自动重连
      setTimeout(() => {
        if (connectionStatus.value !== 'connected') {
          connectSftp()
        }
      }, 2000) // 2秒后重连
    }
  })

  socket.value.on('connect_error', (err) => {
    console.error('sftp-v2 websocket 连接错误：', err)
    connectionStatus.value = 'failed'
    connectionError.value = 'WebSocket连接失败，请检查网络或服务器状态'
    loading.value = false
  })
}

const openDir = (path = currentPath.value, tips = true) => {
  if (!socket.value) return
  socket.value.emit('open_dir', path, tips)
  loading.value = true
}

//----------------------------------
// 文件操作相关（占位实现）
//----------------------------------
const refresh = () => openDir(currentPath.value, false)

const goParent = () => {
  if (currentPath.value === '/') return
  const arr = currentPath.value.split('/').filter(Boolean)
  arr.pop()
  currentPath.value = '/' + arr.join('/')
  openDir(currentPath.value)
}

const changePath = () => {
  if (!currentPath.value) {
    currentPath.value = '/'
  }
  refresh()
}

const toggleHidden = () => {
  showHidden.value = !showHidden.value
}

//================= 路径面包屑 & 编辑 ==================
const isEditingPath = ref(false)
const pathInput = ref('')

const breadcrumb = computed(() => {
  if (currentPath.value === '/') return ['/',]
  const segs = currentPath.value.split('/').filter(Boolean)
  return ['/', ...segs,]
})

const breadcrumbRef = ref(null)

function scrollToEnd() {
  nextTick(() => {
    const el = breadcrumbRef.value
    if (el) el.scrollLeft = el.scrollWidth
  })
}

watch(currentPath, () => scrollToEnd())

const handleBreadcrumb = (idx) => {
  if (idx === 0) {
    currentPath.value = '/'
  } else {
    const segs = breadcrumb.value.slice(1, idx + 1)
    currentPath.value = '/' + segs.join('/')
  }
  openDir(currentPath.value, true)
}

const toggleEditPath = () => {
  isEditingPath.value = true
  pathInput.value = currentPath.value
  nextTick(() => {
    const inputEl = document.querySelector('.path_input input')
    inputEl && inputEl.focus()
  })
}

const confirmPathInput = () => {
  if (!pathInput.value) return
  currentPath.value = pathInput.value
  isEditingPath.value = false
  openDir(currentPath.value, true)
}

const cancelEditPath = () => {
  isEditingPath.value = false
}

const copyCurrentPath = () => {
  navigator.clipboard.writeText(currentPath.value).then(() => {
    $message.success('路径已复制到剪贴板')
  }).catch(() => {
    $message.error('复制失败')
  })
}

const handleUpload = (type) => {
  $message.info(`todo: 上传${ type === 'file' ? '文件' : '文件夹' } (占位)`)
}

const handleNew = (type) => {
  createType.value = type
  createName.value = ''
  showCreatePopover.value = true

  // 等待 Popover 完全显示后再聚焦
  setTimeout(() => {
    if (createInputRef.value) {
      // Element Plus el-input 组件的聚焦方法
      createInputRef.value.focus()
    }
  }, 100)
}

const confirmCreate = () => {
  if (!createName.value.trim()) return
  if (!socket.value) return

  loading.value = true
  showCreatePopover.value = false

  socket.value.emit('create_item', {
    dirPath: currentPath.value,
    name: createName.value.trim(),
    type: createType.value // 'folder' or 'file'
  })
}

//----------------------------------
// 列表事件
//----------------------------------
const onRowClick = (row) => {
  // 文件夹 → 进入下级
  if (row.type === 'd') {
    const base = currentPath.value === '/' ? '' : currentPath.value
    const newPath = `${ base }/${ row.name }`.replace(/\/+/g, '/').replace(/\/\/$/, '/')
    currentPath.value = newPath
    openDir(newPath, true)
  } else {
    // 文件 — 暂无处理
  }
}

const onSelectionChange = (rows) => {
  selectedRows.value = rows
}

const isArchiveFile = (filename) => {
  return /(\.zip|\.tar\.gz|\.tgz|\.tar|\.rar)$/i.test(filename)
}

// ============== Rename ==============
const editingRow = ref(null)
const editingName = ref('')

const isEditing = (row) => editingRow.value === row

const startRename = (row) => {
  editingRow.value = row
  editingName.value = row.name
  nextTick(() => {
    const inputEl = document.querySelector('.rename_input input')
    inputEl && inputEl.focus()
  })
}

const confirmRename = (row) => {
  const newName = editingName.value.trim()
  if (!newName || newName === row.name) return cancelRename()
  loading.value = true
  socket.value.emit('rename', { dirPath: currentPath.value, oldName: row.name, newName })
}

const cancelRename = () => {
  editingRow.value = null
  editingName.value = ''
}

function getIcon(type) {
  return ({ d: dirIcon, l: linkIcon, '-': fileIcon })[type] || unknowIcon
}

const onRowContextMenu = (row, _column, event) => {
  event.preventDefault()
  // 自动切换当前行的选中状态，确保右键操作作用于选中集合
  if (!selectedRows.value.includes(row)) {
    tableRef.value.clearSelection()
    tableRef.value.toggleRowSelection(row, true)
  }

  // 检查是否为多选状态
  const isMultiSelected = selectedRows.value.length > 1

  const items = [
    {
      label: '收藏',
      onClick: () => $message.info('收藏 (占位)')
    },
  ]

  // 始终显示下载菜单（支持单文件和多文件下载）
  items.push({
    label: '下载',
    onClick: () => handleDownload(row)
  })

  items.push(
    {
      label: '复制到...',
      onClick: () => handleCopy(row)
    },
    {
      label: '移动到...',
      onClick: () => handleMove(row)
    },
    {
      label: '压缩',
      onClick: () => handleCompress(row)
    }
  )

  // 解压功能只在单选且为压缩文件时显示
  if (!isMultiSelected && row.type === '-' && isArchiveFile(row.name)) {
    items.push({
      label: '解压',
      onClick: () => handleDecompress(row)
    })
  }

  items.push({
    label: '删除',
    onClick: () => handleDelete(row)
  })

  // 重命名只在单选时显示
  if (!isMultiSelected) {
    items.push({
      label: '重命名',
      onClick: () => startRename(row)
    })
  }

  items.push({
    label: '复制路径',
    onClick: () => {
      navigator.clipboard.writeText(currentPath.value + '/' + row.name)
      $message.success('已复制路径')
    }
  })

  showMenu(event, items)
}

//----------------------------------
// 格式化器
//----------------------------------

function sizeFormatter(row, column, cellValue) {
  const bytes = Number(cellValue)
  if (isNaN(bytes) || bytes === 0) return '-'
  const KB = 1024, MB = KB * 1024, GB = MB * 1024, TB = GB * 1024
  if (bytes < MB) return (bytes / KB).toFixed(1) + ' KB'
  if (bytes < GB) return (bytes / MB).toFixed(1) + ' MB'
  if (bytes < TB) return (bytes / GB).toFixed(1) + ' GB'
  return (bytes / TB).toFixed(1) + ' TB'
}

function timeFormatter(row, column, cellValue) {
  if (!cellValue) return ''
  const date = new Date(Number(cellValue))
  const pad = (n) => n.toString().padStart(2, '0')
  const Y = date.getFullYear()
  const M = pad(date.getMonth() + 1)
  const D = pad(date.getDate())
  const h = pad(date.getHours())
  const m = pad(date.getMinutes())
  const s = pad(date.getSeconds())
  return `${ Y }-${ M }-${ D } ${ h }:${ m }:${ s }`
}

const handleDelete = (row) => {
  const targets = selectedRows.value.length > 1 && selectedRows.value.includes(row) ? selectedRows.value : [row,]
  const namesStr = targets.map(t => t.name).join(', ')

  $messageBox.confirm(`确认删除以下文件(夹)：\n${ namesStr }`, 'Warning', {
    confirmButtonText: '确定',
    cancelButtonText: '取消',
    type: 'warning'
  }).then(() => {
    loading.value = true
    socket.value.emit('delete_batch', { dirPath: currentPath.value, targets: targets.map(t=>({ name:t.name, type:t.type })) })
  })
}

const handleMove = (row) => {
  const targets = selectedRows.value.length > 1 && selectedRows.value.includes(row) ? selectedRows.value : [row,]
  $messageBox.prompt('', '移动到...', {
    confirmButtonText: '确定',
    cancelButtonText: '取消',
    inputType: 'text',
    inputValue: currentPath.value + '/',
    inputPlaceholder: '目标路径',
    inputValidator: (v)=> !!v || '请输入目标路径'
  }).then(({ value }) => {
    const destDir = value.trim()
    if (!destDir) return
    loading.value = true
    if (targets.length === 1) {
      const t = targets[0]
      socket.value.emit('move', { dirPath: currentPath.value, destDir, name: t.name })
    } else {
      socket.value.emit('move_batch', { dirPath: currentPath.value, destDir, targets: targets.map(t=>({ name:t.name })) })
    }
  })
}

const handleCopy = (row) => {
  const targets = selectedRows.value.length > 1 && selectedRows.value.includes(row) ? selectedRows.value : [row,]
  $messageBox.prompt('', '复制到...', {
    inputType: 'text',
    inputValue: currentPath.value + '/',
    inputPlaceholder: '目标路径',
    confirmButtonText: '确定',
    cancelButtonText: '取消',
    inputValidator: (v)=> !!v || '请输入目标路径'
  }).then(({ value }) => {
    const destDir = value.trim()
    if (!destDir) return
    loading.value = true
    socket.value.emit('copy_server_batch', { dirPath: currentPath.value, destDir, targets: targets.map(t=>({ name:t.name })) })
  })
}

const handleCompress = (row) => {
  const targets = selectedRows.value.length > 1 && selectedRows.value.includes(row) ? selectedRows.value : [row,]
  const defaultName = targets.length === 1 ?
    `${ targets[0].name }.tar.gz` :
    `archive-${ Date.now() }.tar.gz`

  $messageBox.prompt('', '压缩文件', {
    inputType: 'text',
    inputValue: defaultName,
    inputPlaceholder: '压缩文件名（建议以.tar.gz结尾）',
    confirmButtonText: '确定',
    cancelButtonText: '取消',
    inputValidator: (v) => !!v?.trim() || '请输入压缩文件名'
  }).then(({ value }) => {
    const archiveName = value.trim()
    if (!archiveName) return

    loading.value = true
    socket.value.emit('compress_files', {
      dirPath: currentPath.value,
      targets: targets.map(t => ({ name: t.name, type: t.type })),
      archiveName
    })
  })
}

const handleDecompress = (row) => {
  // 解压功能只对单个压缩文件有效
  if (row.type !== '-' || !isArchiveFile(row.name)) {
    $message.error('只能解压压缩文件')
    return
  }

  // 获取文件名（去掉扩展名）用于创建同名文件夹
  const baseName = row.name.replace(/\.(tar\.gz|tgz|tar|zip)$/i, '')

  $messageBox.confirm('', '选择解压方式', {
    confirmButtonText: '解压到当前文件夹',
    cancelButtonText: '解压到同名文件夹',
    message: `文件: ${ row.name }\n\n`,
    type: 'question',
    showCancelButton: true,
    cancelButtonClass: 'el-button--primary',
    confirmButtonClass: 'el-button--success'
  }).then(() => {
    // 解压到当前文件夹
    loading.value = true
    socket.value.emit('decompress_file', {
      dirPath: currentPath.value,
      fileName: row.name,
      mode: 'current'
    })
  }).catch(() => {
    // 解压到同名文件夹
    loading.value = true
    socket.value.emit('decompress_file', {
      dirPath: currentPath.value,
      fileName: row.name,
      mode: 'folder',
      folderName: baseName
    })
  })
}

// 下载功能
const handleDownload = (row) => {
  // 支持单文件和多文件下载
  const targets = selectedRows.value.length > 1 && selectedRows.value.includes(row)
    ? selectedRows.value.map(r => ({ name: r.name, type: r.type }))
    : [{ name: row.name, type: row.type },]

  loading.value = true
  socket.value.emit('download_request', {
    dirPath: currentPath.value,
    targets
  })
}

// 取消下载
const cancelDownload = (taskId) => {
  if (taskId) {
    socket.value.emit('download_cancel', { taskId })
  }
}

// 显示下载任务管理器
const showDownloadManager = () => {
  showDownloadDialog.value = true
}

// 手动下载文件
const downloadFile = (task) => {
  if (task.downloadUrl) {
    window.open(task.downloadUrl, '_blank')
    $message.success(`开始下载: ${ task.fileName }`)
  }
}

// 格式化文件大小
const formatSize = (bytes) => {
  if (!bytes || bytes === 0) return '0 B'
  const KB = 1024, MB = KB * 1024, GB = MB * 1024, TB = GB * 1024
  if (bytes < KB) return bytes + ' B'
  if (bytes < MB) return (bytes / KB).toFixed(1) + ' KB'
  if (bytes < GB) return (bytes / MB).toFixed(1) + ' MB'
  if (bytes < TB) return (bytes / GB).toFixed(1) + ' GB'
  return (bytes / TB).toFixed(1) + ' TB'
}

// 格式化速度
const formatSpeed = (bytesPerSec) => {
  return formatSize(bytesPerSec) + '/s'
}

// 格式化时间
const formatTime = (seconds) => {
  if (!seconds || seconds <= 0) return '计算中...'
  if (seconds < 60) return Math.round(seconds) + ' 秒'
  if (seconds < 3600) return Math.round(seconds / 60) + ' 分钟'
  return Math.round(seconds / 3600) + ' 小时'
}
</script>

<style lang="scss" scoped>
.sftp_v2_container {
  display: flex;
  flex-direction: column;
  height: 100%;

  .tool_bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 10px;
    border-bottom: 1px solid var(--el-border-color);
  }

  .path_bar {
    height: 30px;
    padding: 0 10px;
    display: flex;
    align-items: center;
    border-bottom: 1px solid var(--el-border-color);

    .breadcrumb_wrap {
      line-height: 30px;
      flex: 1;
      display: flex;
      align-items: center;
      white-space: nowrap;
      overflow-x: auto;
      overflow-y: hidden;
      -ms-overflow-style: none; /* IE/Edge */
      scrollbar-width: none; /* Firefox */
      &::-webkit-scrollbar { display: none; }

      .breadcrumb_seg {
        cursor: pointer;
        user-select: none;
        display: flex;
        align-items: center;
        color: var(--el-color-primary);
        & > span {
          margin-top: -2px;
        }
        .separator {
          margin: 0 2px;
          width: 14px;
          height: 14px;
          color: var(--el-text-color-regular);
        }
        svg {
          width: 16px;
          height: 16px;
        }
      }
    }

    .path_input {
      flex: 1;
    }
    .action_icon {
      cursor: pointer;
      font-size: 16px;
      margin-left: 12px;

      &:first-of-type {
        margin: 0 8px 0 0;
      }

      &:hover {
        color: var(--el-color-primary);
      }

      &.download_icon {
        color: var(--el-color-success);
        animation: pulse 1.5s ease-in-out infinite;
      }
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.6; }
    }
  }

  .file_table {
    flex: 1;
    min-width: 0; // 防止表格撑宽
    overflow: auto;
  }

  .file_name_cell {
    display: flex;
    align-items: center;
    cursor: pointer;
    .file_icon {
      width: 16px;
      height: 16px;
      margin-right: 4px;
    }
    .file_name {
      color: var(--el-color-primary);
    }
    .rename_input {
      width: 120px;
      margin-right: 4px;
    }
    .rename_icon {
      cursor: pointer;
      margin-left: 2px;
      font-size: 14px;
      color: var(--el-color-success);
      &:last-child { color: var(--el-color-danger); }
    }
  }

  .sftp_popover_actions {
    margin-top: 12px;
    text-align: right;
  }

  // 连接状态样式
  .connection_status {
    display: flex;
    justify-content: center;
    align-items: center;
    height: 100%;
    min-height: 300px;

    .status_connecting,
    .status_reconnecting {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
      color: var(--el-color-primary);

      .el-icon {
        font-size: 32px;
      }

      span {
        font-size: 16px;
      }
    }

    .status_failed {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 16px;
      max-width: 400px;
      text-align: center;

      .error_icon {
        font-size: 48px;
        color: var(--el-color-danger);
      }

      .error_content {
        h3 {
          margin: 0 0 8px 0;
          font-size: 18px;
          color: var(--el-text-color-primary);
        }

        p {
          margin: 0 0 16px 0;
          color: var(--el-text-color-regular);
          line-height: 1.5;
        }
      }
    }
  }
}
</style>

<style>
/* 全局样式，为 Popover 指定的 popper-class 生效 */
.sftp_create_popover .sftp_popover_actions {
  margin-top: 12px;
}

/* 下载管理器样式 */
.download_manager_container {
  max-height: 60vh;
  overflow-y: auto;
}

.download_section {
  margin-bottom: 24px;
}

.download_section:last-child {
  margin-bottom: 0;
}

.section_title {
  margin: 0 0 12px 0;
  font-size: 14px;
  font-weight: 500;
  color: var(--el-text-color-primary);
}

.download_task_list {
  space-y: 8px;
}

.download_task_item {
  border: 1px solid var(--el-border-color-light);
  border-radius: 6px;
  padding: 12px;
  margin-bottom: 8px;
  background-color: var(--el-bg-color-page);
}

.download_task_item.completed {
  border-color: var(--el-color-success-light-7);
  background-color: var(--el-color-success-light-9);
}

.task_header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.file_info {
  display: flex;
  align-items: center;
  flex: 1;
}

.file_icon {
  margin-right: 8px;
  color: var(--el-color-primary);
  font-size: 16px;
}

.file_icon.success {
  color: var(--el-color-success);
}

.file_name {
  font-weight: 500;
  color: var(--el-text-color-primary);
}

.completed_text {
  color: var(--el-color-success);
  font-size: 12px;
  font-weight: 500;
}

.task_actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.progress_info {
  margin-top: 8px;
}

.progress_details {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 6px;
  font-size: 12px;
}

.progress_text {
  color: var(--el-text-color-regular);
}

.speed_text {
  color: var(--el-text-color-secondary);
}

.no_tasks {
  text-align: center;
  padding: 40px 20px;
  color: var(--el-text-color-secondary);
}

.empty_icon {
  font-size: 48px;
  color: var(--el-color-info-light-5);
  margin-bottom: 12px;
}
</style>
