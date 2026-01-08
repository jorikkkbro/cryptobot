import express, { Request, Response } from 'express'
import path from 'path'
import { config } from './config'
import { connectDB, createUser, getUser, UserModel } from './mongo'
import { balanceManager } from './Balance'
import { auctionManager, AuctionModel } from './Auction'
import { botManager } from './BotManager'

const app = express()
app.use(express.json())
app.use(express.static(path.join(__dirname, '../public')))

// ═══════════════════════════════════════════
// AUCTION
// ═══════════════════════════════════════════

// Список аукционов
app.get('/api/auctions', (req, res) => {
  const auctions = auctionManager.getAllAuctions()
  res.json(auctions.map(a => ({
    id: a.getId(),
    name: a.getName(),
    isRunning: a.isRunning()
  })))
})

// Создать аукцион
app.post('/api/auction', async (req, res) => {
  const { name, gift, plan } = req.body
  if (!name || !gift || !plan) {
    return res.status(400).json({ error: 'name, gift, plan required' })
  }
  const auction = await auctionManager.createAuction(name, gift, plan)
  res.json({ id: auction.getId() })
})

// Запустить аукцион
app.post('/api/auction/:id/start', async (req, res) => {
  const auction = auctionManager.getAuction(req.params.id)
  if (!auction) return res.status(404).json({ error: 'Not found' })
  if (auction.isRunning()) return res.status(400).json({ error: 'Already running' })
  await auction.startRound()
  res.json({ ok: true })
})

// Сделать ставку
app.post('/api/auction/:id/bid', (req, res) => {
  const { userId, amount } = req.body
  if (!userId || !amount) return res.status(400).json({ error: 'userId, amount required' })
  
  const auction = auctionManager.getAuction(req.params.id)
  if (!auction) return res.status(404).json({ error: 'Not found' })
  
  const result = auction.placeBid(userId, amount)
  if (!result.success) return res.status(400).json({ error: result.error })
  res.json({ ok: true, bid: result.newBid })
})

// ═══════════════════════════════════════════
// BALANCE
// ═══════════════════════════════════════════

app.post('/api/balance/:userId/deposit', async (req, res) => {
  const { userId } = req.params
  const { amount } = req.body
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' })

  let user = await getUser(userId)
  if (!user) {
    user = await createUser({ id: userId, balance: amount })
    balanceManager.set(userId, amount)
  } else {
    balanceManager.add(userId, amount)
    await UserModel.updateOne({ id: userId }, { $inc: { balance: amount } })
  }
  res.json({ balance: balanceManager.get(userId) })
})

// ═══════════════════════════════════════════
// BOTS
// ═══════════════════════════════════════════

app.post('/api/bots/generate', async (req, res) => {
  const { count = 10000, balance = 10000 } = req.body
  const result = await botManager.generateBots(count, balance)
  res.json(result)
})

app.post('/api/bots/start', (req, res) => {
  const { auctionId, bidsPerSecond = 500 } = req.body
  if (!auctionId) return res.status(400).json({ error: 'auctionId required' })
  const result = botManager.start(auctionId, bidsPerSecond)
  res.json(result)
})

app.post('/api/bots/stop', (req, res) => {
  botManager.stop()
  res.json({ ok: true })
})

// ═══════════════════════════════════════════
// SSE
// ═══════════════════════════════════════════

app.get('/api/sse/:auctionId', async (req, res) => {
  const { auctionId } = req.params

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const interval = setInterval(async () => {
    const auction = auctionManager.getAuction(auctionId)
    if (!auction) {
      res.write(`event: error\ndata: {"error":"not_found"}\n\n`)
      return
    }

    if (!auction.isRunning()) {
      res.write(`event: ended\ndata: {}\n\n`)
      clearInterval(interval)
      return
    }

    const roundPlan = auction.getCurrentRoundPlan()
    const winnersCount = roundPlan?.count_of_gifts ?? 0
    const leaderboard = auction.getLeaderboard(10)
    const allBids = auction.getLeaderboard(winnersCount)
    const minPassingBid = allBids.length >= winnersCount && winnersCount > 0
      ? allBids[winnersCount - 1]?.amount ?? 0
      : 0

    const bots = botManager.getStats()

    // Получаем победителей из БД
    const auctionDoc = await AuctionModel.findById(auctionId).select('winners').lean()
    const winners = auctionDoc?.winners ?? []

    res.write(`event: state\ndata: ${JSON.stringify({
      round: auction.getCurrentRound() + 1,
      totalRounds: roundPlan ? auction.getTotalGifts() : 0,
      gifts: winnersCount,
      time: auction.getTimeRemaining(),
      bids: auction.getBidsCount(),
      minBid: minPassingBid,
      top10: leaderboard,
      winners,
      bots: {
        active: bots.activeBots,
        bps: bots.bidsPerSecond,
        total: bots.totalBids,
        success: bots.successRate
      }
    })}\n\n`)
  }, 200)

  req.on('close', () => clearInterval(interval))
})

// ═══════════════════════════════════════════
// START
// ═══════════════════════════════════════════

async function main() {
  await connectDB(config.mongoUri)
  await auctionManager.recoverFromDB()
  await botManager.loadExistingBots()

  app.listen(config.port, () => {
    console.log(`
🚀 Server: http://localhost:${config.port}

API:
  GET  /api/auctions              - список
  POST /api/auction               - создать {name, gift, plan}
  POST /api/auction/:id/start     - запустить
  POST /api/auction/:id/bid       - ставка {userId, amount}
  POST /api/balance/:id/deposit   - пополнить {amount}
  POST /api/bots/generate         - создать {count, balance}
  POST /api/bots/start            - запустить {auctionId, bidsPerSecond}
  POST /api/bots/stop             - остановить
  GET  /api/sse/:auctionId        - SSE стрим
    `)
  })
}

main()