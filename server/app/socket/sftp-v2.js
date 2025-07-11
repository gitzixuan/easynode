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
        fs.emptyDir(sftpCacheDir)
        consola.success('clean sftpCacheDir: ', sftpCacheDir)
        jumpSshClients?.forEach(sshClient => sshClient && sshClient.end())
        jumpSshClients = null
      }
    })
  })
}
