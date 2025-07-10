<template>
  <div class="sftp_v2_container">
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
            <el-dropdown-item @click="handleNew('folder')">新建文件夹</el-dropdown-item>
            <el-dropdown-item @click="handleNew('file')">新建文件</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>

      <!-- 压缩 -->
      <el-button
        size="small"
        :disabled="!hasSelection"
        @click="handleCompress"
      >
        压缩
      </el-button>
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
      <el-icon class="action_icon" @click="toggleEditPath"><Edit /></el-icon>
      <el-icon class="action_icon" @click="refresh"><Refresh /></el-icon>
      <el-icon class="action_icon" @click="toggleHidden">
        <View v-if="showHidden" />
        <Hide v-else />
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
      <el-table-column label="名称" width="auto">
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
          v-model="createName"
          :placeholder="createType === 'folder' ? '输入文件夹名称' : '输入文件名称'"
          size="small"
          @keyup.enter="confirmCreate"
        />
        <div class="sftp_popover_actions">
          <el-button size="small" @click="showCreatePopover = false">取消</el-button>
          <el-button size="small" type="primary" @click="confirmCreate">确认</el-button>
        </div>
      </template>
    </el-popover>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, watch, getCurrentInstance, nextTick } from 'vue'
import { ArrowDown, ArrowLeft, Refresh, View, Hide, Edit, ArrowRight, HomeFilled, Check, Close as CloseIcon } from '@element-plus/icons-vue'
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
const { proxy: { $store, $message, $notification, $serviceURI } } = getCurrentInstance()

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
const hasSelection = computed(() => selectedRows.value.length > 0)
const tableRef = ref(null)

// 上传 & 新建 (Popover)
const showCreatePopover = ref(false)
const createType = ref('folder') // 'folder' | 'file'
const createName = ref('')
const createPopoverRef = ref(null) // 固定参照元素 (新建按钮)
const newBtnRef = ref(null)

// 上下文菜单
const { showMenu } = useContextMenu()

//----------------------------------
// 初始化
//----------------------------------
onMounted(() => {
  connectSftp()
  nextTick(() => {
    createPopoverRef.value = newBtnRef.value
  })
})

//----------------------------------
// Socket 连接 & 目录操作
//----------------------------------

const connectSftp = () => {
  const { io } = socketIo
  loading.value = true
  socket.value = io($serviceURI, {
    path: '/sftp-v2',
    forceNew: false,
    reconnectionAttempts: 1
  })

  socket.value.on('connect', () => {
    socket.value.emit('ws_sftp', { hostId: props.hostId, token: token.value })

    socket.value.on('connect_success', ({ rootList }) => {
      fileListRaw.value = rootList
      currentPath.value = '/'
      loading.value = false
    })

    socket.value.on('connect_fail', (msg) => {
      $notification({ title: 'Sftp 连接失败', message: msg, type: 'error' })
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
  })

  socket.value.on('connect_error', (err) => {
    console.error('sftp-v2 websocket 连接错误：', err)
    $notification({ title: 'sftp连接失败', message: '请检查socket服务是否正常', type: 'error' })
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

const handleUpload = (type) => {
  $message.info(`todo: 上传${ type === 'file' ? '文件' : '文件夹' } (占位)`)
}

const handleNew = (type) => {
  createType.value = type
  createName.value = ''
  showCreatePopover.value = true
}

const confirmCreate = () => {
  if (!createName.value.trim()) return
  const text = createType.value === 'folder' ? '文件夹' : '文件'
  $message.success(`新建${ text }：${ createName.value } (占位)`)
  showCreatePopover.value = false
  refresh()
}

const handleCompress = () => {
  $message.info('压缩功能待实现 (占位)')
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
  return /(\.zip|\.tar\.gz|\.tgz|\.rar)$/i.test(filename)
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
  const items = [
    {
      label: '收藏',
      onClick: () => $message.info('收藏 (占位)')
    },
    {
      label: '下载',
      onClick: () => $message.info('下载 (占位)')
    },
    {
      label: '复制',
      onClick: () => $message.info('复制 (占位)')
    },
    {
      label: '移动',
      onClick: () => $message.info('移动 (占位)')
    },
    {
      label: '删除',
      onClick: () => $message.info('删除 (占位)')
    },
    {
      label: '重命名',
      onClick: () => startRename(row)
    },
    {
      label: '复制路径',
      onClick: () => {
        navigator.clipboard.writeText(currentPath.value + '/' + row.name)
        $message.success('已复制路径')
      }
    },
  ]
  if (row.type === '-' && isArchiveFile(row.name)) {
    items.push({
      label: '解压',
      onClick: () => $message.info('解压 (占位)')
    })
  }
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
    gap: 6px;
    border-bottom: 1px solid var(--el-border-color);

    .breadcrumb_wrap {
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
        .separator {
          margin: 0 4px;
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
      &:hover {
        color: var(--el-color-primary);
      }
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
}
</style>

<style>
/* 全局样式，为 Popover 指定的 popper-class 生效 */
.sftp_create_popover .sftp_popover_actions {
  margin-top: 12px;
}
</style>
