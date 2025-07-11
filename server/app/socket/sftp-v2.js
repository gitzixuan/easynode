const rawPath = require('path')
const fs = require('fs-extra')
const SFTPClient = require('ssh2-sftp-client')
const CryptoJS = require('crypto-js')
const { Server } = require('socket.io')
const { sftpCacheDir } = require('../config')
const { verifyAuthSync } = require('../utils/verify-auth')
const { isAllowedIp } = require('../utils/tools')
const { HostListDB } = require('../utils/db-class')
const { getConnectionOptions } = require('./terminal')
const decryptAndExecuteAsync = require('../utils/decrypt-file')
const hostListDB = new HostListDB().getInstance()
const { Client: SSHClient } = require('ssh2')

const listenAction = (sftpClient, socket, isRootUser) => {
  // 下载任务管理
  const downloadTasks = new Map() // taskId -> { abortController, startTime, totalSize, downloadedSize }

  socket.on('open_dir', async (path) => {
    try {
      const dirLs = await sftpClient.list(path)
      console.log('dirLs:', dirLs.length)
      socket.emit('dir_ls', dirLs, path)
    } catch (err) {
      socket.emit('not_exists_dir', err.message)
    }
  })

  // rename file / directory
  socket.on('rename', async ({ dirPath, oldName, newName }) => {
    try {
      if (!oldName || !newName || oldName === newName) throw new Error('无效文件名')
      const src = rawPath.posix.join(dirPath, oldName)
      const dest = rawPath.posix.join(dirPath, newName)
      await sftpClient.rename(src, dest)
      socket.emit('rename_success', { oldName, newName })
      // 返回最新目录列表
      const dirLs = await sftpClient.list(dirPath)
      socket.emit('dir_ls', dirLs, dirPath)
    } catch (err) {
      socket.emit('rename_fail', err.message)
    }
  })

  // delete file/dir
  socket.on('delete', async ({ dirPath, name, type }) => {
    try {
      const target = rawPath.posix.join(dirPath, name)
      if (type === 'd') {
        await sftpClient.rmdir(target, true)
      } else {
        await sftpClient.delete(target)
      }
      socket.emit('delete_success')
      const dirLs = await sftpClient.list(dirPath)
      socket.emit('dir_ls', dirLs, dirPath)
    } catch (err) {
      socket.emit('delete_fail', err.message)
    }
  })

  socket.on('delete_batch', async ({ dirPath, targets }) => {
    try {
      for (const { name, type } of targets) {
        const target = rawPath.posix.join(dirPath, name)
        if (type === 'd') {
          await sftpClient.rmdir(target, true)
        } else {
          await sftpClient.delete(target)
        }
      }
      socket.emit('delete_success')
      const dirLs = await sftpClient.list(dirPath)
      socket.emit('dir_ls', dirLs, dirPath)
    } catch (err) {
      socket.emit('delete_fail', err.message)
    }
  })

  // move file/dir
  socket.on('move', async ({ dirPath, destDir, name }) => {
    try {
      const src = rawPath.posix.join(dirPath, name)
      await ensureDir(destDir)
      const dest = rawPath.posix.join(destDir, name)
      await sftpClient.rename(src, dest)
      socket.emit('move_success')
      const dirLs = await sftpClient.list(dirPath)
      socket.emit('dir_ls', dirLs, dirPath)
    } catch (err) {
      socket.emit('move_fail', err.message)
    }
  })

  socket.on('move_batch', async ({ dirPath, destDir, targets }) => {
    try {
      await ensureDir(destDir)
      for (const { name } of targets) {
        const src = rawPath.posix.join(dirPath, name)
        const dest = rawPath.posix.join(destDir, name)
        await sftpClient.rename(src, dest)
      }
      socket.emit('move_success')
      const dirLs = await sftpClient.list(dirPath)
      socket.emit('dir_ls', dirLs, dirPath)
    } catch (err) {
      socket.emit('move_fail', err.message)
    }
  })

  async function ensureDir(dir) {
    const exists = await sftpClient.exists(dir)
    if (!exists) {
      await sftpClient.mkdir(dir, true)
    }
  }

  const execCommand = (cmd) => new Promise((res, rej) => {
    sftpClient.client.exec(cmd, (err, stream) => {
      if (err) return rej(err)

      let errMsg = ''
      stream.stderr.on('data', d => (errMsg += d.toString()))

      stream.on('exit', (code) => {
        if (code === 0) res() // 成功
        else rej(new Error(errMsg || `exit ${ code }`))
      })

      // 消耗 stdout 防止阻塞
      stream.on('data', () => {})
    })
  })

  // -------- copy (download then upload) --------
  socket.on('copy_server_batch', async ({ dirPath, destDir, targets }) => {
    try {
      await ensureDir(destDir)
      for (const { name } of targets) {
        const src = rawPath.posix.join(dirPath, name)
        // cp -r preserves dir/file, will overwrite if exists
        const cmd = `cp -r -- "${ src }" "${ destDir }/"`
        await execCommand(cmd)
      }

      socket.emit('copy_success')
      const dirLs = await sftpClient.list(dirPath)
      socket.emit('dir_ls', dirLs, dirPath)
    } catch (err) {
      consola.error('copy error:', err.message)
      socket.emit('copy_fail', err.message)
    }
  })

  // 下载功能
  socket.on('download_request', async ({ dirPath, target }) => {
    try {
      if (!target) {
        throw new Error('未选择要下载的文件(夹)')
      }

      const taskId = Date.now() + '-' + Math.random().toString(36).slice(2)
      const taskDir = rawPath.join(sftpCacheDir, taskId)
      await fs.ensureDir(taskDir)

      const abortController = new AbortController()
      downloadTasks.set(taskId, {
        abortController,
        startTime: Date.now(),
        totalSize: 0,
        downloadedSize: 0
      })

      socket.emit('download_started', { taskId, fileName: target.name })

      const srcPath = rawPath.posix.join(dirPath, target.name)

      if (target.type === 'd') {
        // 文件夹：先在远端打包
        const tarFileName = `${ target.name }.tar.gz`
        const remoteTarPath = `/tmp/${ taskId }.tar.gz`
        const localTarPath = rawPath.join(taskDir, tarFileName)

        // 检查是否被取消
        if (abortController.signal.aborted) {
          throw new Error('下载已取消')
        }

        // 在远端打包
        consola.info(`开始打包文件夹: ${ srcPath }`)
        const tarCmd = `cd "${ dirPath }" && tar -czf "${ remoteTarPath }" "${ target.name }"`
        await execCommand(tarCmd)
        consola.info(`打包文件夹: ${ srcPath } 成功`)
        // 获取打包文件大小
        const statResult = await sftpClient.stat(remoteTarPath)
        const totalSize = statResult.size

        downloadTasks.get(taskId).totalSize = totalSize

        // 下载打包文件
        await downloadFileWithProgress(sftpClient, remoteTarPath, localTarPath, taskId, downloadTasks, socket, abortController)

        // 清理远端临时文件
        try {
          await execCommand(`rm -f "${ remoteTarPath }"`)
        } catch (cleanupErr) {
          consola.warn('清理远端临时文件失败:', cleanupErr.message)
        }

        socket.emit('download_ready', { taskId, fileName: tarFileName })
      } else {
        // 单文件：直接下载
        const localFilePath = rawPath.join(taskDir, target.name)

        // 获取文件大小
        const statResult = await sftpClient.stat(srcPath)
        const totalSize = statResult.size

        downloadTasks.get(taskId).totalSize = totalSize

        await downloadFileWithProgress(sftpClient, srcPath, localFilePath, taskId, downloadTasks, socket, abortController)

        socket.emit('download_ready', { taskId, fileName: target.name })
      }

      downloadTasks.delete(taskId)
    } catch (err) {
      consola.error('下载失败:', err.message)
      socket.emit('download_fail', err.message)

      // 清理任务
      if (err.taskId) {
        downloadTasks.delete(err.taskId)
      }
    }
  })

  // 取消下载
  socket.on('download_cancel', ({ taskId }) => {
    const task = downloadTasks.get(taskId)
    if (task) {
      task.abortController.abort()
      downloadTasks.delete(taskId)
      socket.emit('download_cancelled', { taskId })

      // 如果没有其他下载任务，清理缓存目录
      if (downloadTasks.size === 0) {
        cleanupCacheDir()
      }
    }
  })

  // 清理缓存目录
  const cleanupCacheDir = () => {
    try {
      fs.emptyDirSync(sftpCacheDir)
      consola.success('已清理 sftpCacheDir:', sftpCacheDir)
    } catch (err) {
      consola.warn('清理缓存目录失败:', err.message)
    }
  }

  // 监听连接断开，清理下载任务和缓存
  socket.on('disconnect', () => {
    // 取消所有下载任务
    for (const [taskId, task] of downloadTasks) {
      task.abortController.abort()
    }
    downloadTasks.clear()

    // 清理缓存目录
    cleanupCacheDir()
  })

  // 带进度的文件下载函数
  async function downloadFileWithProgress(sftpClient, remotePath, localPath, taskId, downloadTasks, socket, abortController) {
    return new Promise((resolve, reject) => {
      const task = downloadTasks.get(taskId)
      if (!task) {
        return reject(new Error('任务不存在'))
      }

      let lastUpdateTime = Date.now()
      let lastDownloadedSize = 0

      const progressInterval = setInterval(() => {
        if (abortController.signal.aborted) {
          clearInterval(progressInterval)
          return
        }

        const now = Date.now()
        const currentTask = downloadTasks.get(taskId)
        if (!currentTask) {
          clearInterval(progressInterval)
          return
        }

        const { totalSize, downloadedSize, startTime } = currentTask
        const elapsed = (now - startTime) / 1000 // 秒
        const progress = totalSize > 0 ? (downloadedSize / totalSize * 100) : 0

        // 计算速度 (bytes/s)
        const timeDiff = (now - lastUpdateTime) / 1000
        const sizeDiff = downloadedSize - lastDownloadedSize
        const speed = timeDiff > 0 ? sizeDiff / timeDiff : 0

        // 计算剩余时间
        const remainingBytes = totalSize - downloadedSize
        const eta = speed > 0 ? remainingBytes / speed : 0

        socket.emit('download_progress', {
          taskId,
          progress: Math.min(progress, 100),
          downloadedSize,
          totalSize,
          speed: Math.round(speed),
          eta: Math.round(eta)
        })

        lastUpdateTime = now
        lastDownloadedSize = downloadedSize
      }, 1000) // 每1秒更新

      const readStream = sftpClient.createReadStream(remotePath)
      const writeStream = fs.createWriteStream(localPath)

      readStream.on('data', (chunk) => {
        if (abortController.signal.aborted) {
          readStream.destroy()
          writeStream.destroy()
          fs.unlink(localPath).catch(() => {}) // 删除部分下载的文件
          clearInterval(progressInterval)
          reject(new Error('下载已取消'))
          return
        }

        const currentTask = downloadTasks.get(taskId)
        if (currentTask) {
          currentTask.downloadedSize += chunk.length
        }
      })

      readStream.on('error', (err) => {
        clearInterval(progressInterval)
        writeStream.destroy()
        fs.unlink(localPath).catch(() => {})
        reject(err)
      })

      writeStream.on('error', (err) => {
        clearInterval(progressInterval)
        readStream.destroy()
        fs.unlink(localPath).catch(() => {})
        reject(err)
      })

      writeStream.on('finish', () => {
        clearInterval(progressInterval)
        resolve()
      })

      readStream.pipe(writeStream)
    })
  }
}

module.exports = (httpServer) => {
  const serverIo = new Server(httpServer, {
    path: '/sftp-v2',
    cors: {
      origin: '*'
    }
  })
  serverIo.on('connection', (socket) => {
    let requestIP = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address
    if (!isAllowedIp(requestIP)) {
      socket.emit('ip_forbidden', 'IP地址不在白名单中')
      socket.disconnect()
      return
    }
    let sftpClient = new SFTPClient()
    consola.success('sftp-v2 websocket 已连接')
    let jumpSshClients = []

    socket.on('ws_sftp', async ({ hostId, token }) => {
      const { code } = await verifyAuthSync(token, requestIP)
      if (code !== 1) {
        socket.emit('token_verify_fail')
        socket.disconnect()
        return
      }
      const targetHostInfo = await hostListDB.findOneAsync({ _id: hostId })
      if (!targetHostInfo) throw new Error(`Host with ID ${ hostId } not found`)

      let { connectByJumpHosts = null } = (await decryptAndExecuteAsync(rawPath.join(__dirname, 'plus.js'))) || {}
      let { authType, host, port, username, jumpHosts } = targetHostInfo

      let { authInfo: targetConnectionOptions } = await getConnectionOptions(hostId)
      let jumpHostResult = connectByJumpHosts && (await connectByJumpHosts(jumpHosts, targetConnectionOptions.host, targetConnectionOptions.port, socket))
      if (jumpHostResult) {
        targetConnectionOptions.sock = jumpHostResult.sock
        jumpSshClients = jumpHostResult.sshClients
        consola.success('sftp-v2 跳板机连接成功')
      }

      consola.info('准备连接sftp-v2 面板：', host)
      consola.log('连接信息', { username, port, authType })

      sftpClient.client = new SSHClient()
      sftpClient.client.on('keyboard-interactive', function (name, instructions, instructionsLang, prompts, finish) {
        finish([targetConnectionOptions[authType]])
      })

      try {
        await sftpClient.connect({
          tryKeyboard: true,
          ...targetConnectionOptions
        })
        consola.success('连接sftp-v2 成功：', host)
        fs.ensureDirSync(sftpCacheDir)
        let rootList = []
        let isRootUser = true
        try {
          rootList = await sftpClient.list('/')
          consola.success('获取根目录成功')
        } catch (error) {
          consola.error('获取根目录失败:', error.message)
          consola.info('尝试获取当前目录')
          isRootUser = false
          rootList = await sftpClient.list('./')
          consola.success('获取当前目录成功')
        }
        // 普通文件-、目录文件d、链接文件l
        socket.emit('connect_success', { rootList, isRootUser })
        consola.success('连接sftp-v2 成功：', host)
        listenAction(sftpClient, socket, isRootUser)
      } catch (error) {
        consola.error('连接sftp-v2 失败：', error.message)
        socket.emit('connect_fail', error.message)
        socket.disconnect()
      }
    })

    socket.on('disconnect', async () => {
      try {
        await sftpClient.end()
        consola.info('sftp-v2 连接断开')
      } catch (error) {
        consola.info('sftp断开连接失败:', error.message)
      } finally {
        sftpClient = null
        // 这里不再清理缓存目录，因为在 listenAction 中的 disconnect 处理器会处理
        jumpSshClients?.forEach(sshClient => sshClient && sshClient.end())
        jumpSshClients = null
      }
    })
  })
}
