const { Server } = require('socket.io')
const { Client: SSHClient } = require('ssh2')
const { verifyAuthSync } = require('../utils/verify-auth')
const { sendNoticeAsync } = require('../utils/notify')
const { isAllowedIp, ping } = require('../utils/tools')
const { HostListDB } = require('../utils/db-class')
const { getConnectionOptions, connectByJumpHosts } = require(process.env.NODE_ENV === 'dev' ? './plus-clear' : './plus')
const hostListDB = new HostListDB().getInstance()

function createInteractiveShell(socket, targetSSHClient) {
  return new Promise((resolve) => {
    targetSSHClient.shell({ term: 'xterm-color' }, (err, stream) => {
      resolve(stream)
      if (err) return socket.emit('output', err.toString())
      // 终端输出
      stream
        .on('data', (data) => {
          socket.emit('output', data.toString())
        })
        .on('close', () => {
          consola.info('交互终端已关闭')
          targetSSHClient.end()
        })
      socket.emit('connect_shell_success') // 已连接终端，web端可以执行指令了
    })
  })
}

async function createTerminal(hostId, socket, targetSSHClient) {
  return new Promise(async (resolve) => {
    const targetHostInfo = await hostListDB.findOneAsync({ _id: hostId })
    if (!targetHostInfo) return socket.emit('create_fail', `查找hostId【${ hostId }】凭证信息失败`)
    let { authType, host, port, username, name, jumpHosts } = targetHostInfo
    try {
      let { authInfo: targetConnectionOptions } = await getConnectionOptions(hostId)
      let jumpHostResult = await connectByJumpHosts(jumpHosts, targetConnectionOptions.host, targetConnectionOptions.port, socket)
      if (jumpHostResult) {
        targetConnectionOptions.sock = jumpHostResult.sock
      }

      socket.emit('terminal_print_info', `准备连接目标终端: ${ name } - ${ host }`)
      socket.emit('terminal_print_info', `连接信息: ssh ${ username }@${ host } -p ${ port }  ->  ${ authType }`)

      consola.info('准备连接目标终端：', host)
      consola.log('连接信息', { username, port, authType })
      targetSSHClient
        .on('ready', async() => {
          sendNoticeAsync('host_login', '终端登录', `别名: ${ name } \n IP：${ host } \n 端口：${ port } \n 状态: 登录成功`)
          socket.emit('terminal_print_info', `终端连接成功: ${ name } - ${ host }`)
          consola.success('终端连接成功：', host)
          socket.emit('connect_terminal_success', `终端连接成功：${ host }`)
          let stream = await createInteractiveShell(socket, targetSSHClient)
          resolve(stream)
        })
        .on('close', () => {
          consola.info('终端连接断开close: ', host)
          socket.emit('connect_close')
        })
        .on('error', (err) => {
          consola.log(err)
          sendNoticeAsync('host_login', '终端登录', `别名: ${ name } \n IP：${ host } \n 端口：${ port } \n 状态: 登录失败`)
          consola.error('连接终端失败:', host, err.message)
          socket.emit('connect_fail', err.message)
        })
        .connect({
          ...targetConnectionOptions
        // debug: (info) => console.log(info)
        })

    } catch (err) {
      consola.error('创建终端失败: ', host, err.message)
      socket.emit('create_fail', err.message)
    }
  })
}

module.exports = (httpServer) => {
  const serverIo = new Server(httpServer, {
    path: '/terminal',
    cors: {
      origin: '*' // 'http://localhost:8080'
    }
  })
  serverIo.on('connection', (socket) => {
    // 前者兼容nginx反代, 后者兼容nodejs自身服务
    let requestIP = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address
    if (!isAllowedIp(requestIP)) {
      socket.emit('ip_forbidden', 'IP地址不在白名单中')
      socket.disconnect()
      return
    }
    consola.success('terminal websocket 已连接')
    let targetSSHClient = null
    socket.on('create', async ({ hostId, token }) => {
      const { code } = await verifyAuthSync(token, requestIP)
      if (code !== 1) {
        socket.emit('token_verify_fail')
        socket.disconnect()
        return
      }
      targetSSHClient = new SSHClient()
      let stream = null
      function listenerInput(key) {
        if (targetSSHClient._sock.writable === false) return consola.info('终端连接已关闭,禁止输入')
        stream && stream.write(key)
      }
      function resizeShell({ rows, cols }) {
        // consola.info('更改tty终端行&列: ', { rows, cols })
        stream && stream.setWindow(rows, cols)
      }
      socket.on('input', listenerInput)
      socket.on('resize', resizeShell)

      // 重连
      socket.on('reconnect_terminal', async () => {
        consola.info('重连终端: ', hostId)
        socket.off('input', listenerInput) // 取消监听,重新注册监听,操作新的stream
        socket.off('resize', resizeShell)
        targetSSHClient?.end()
        targetSSHClient?.destroy()
        targetSSHClient = null
        stream = null
        setTimeout(async () => {
          // 初始化新的SSH客户端对象
          targetSSHClient = new SSHClient()
          stream = await createTerminal(hostId, socket, targetSSHClient)
          socket.emit('reconnect_terminal_success')
          socket.on('input', listenerInput)
          socket.on('resize', resizeShell)
        }, 3000)
      })
      stream = await createTerminal(hostId, socket, targetSSHClient)
    })

    socket.on('get_ping',async (ip) => {
      try {
        socket.emit('ping_data', await ping(ip, 2500))
      } catch (error) {
        socket.emit('ping_data', { success: false, msg: error.message })
      }
    })

    socket.on('disconnect', (reason) => {
      consola.info('终端socket连接断开:', reason)
    })
  })
}
