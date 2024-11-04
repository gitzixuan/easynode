const { httpServer } = require('./server')
const initDB = require('./db')
const scheduleJob = require('./schedule')
require(process.env.NODE_ENV === 'dev' ? './utils/plus-clear' : './utils/plus')()

async function main() {
  await initDB()
  httpServer()
  scheduleJob()
}

main()
