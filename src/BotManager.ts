import { balanceManager } from './Balance'
import { auctionManager, Auction } from './Auction'
import { bulkCreateUsers, getAllBotIds, getBotsCount, saveBalances } from './mongo'

// ═══════════════════════════════════════════
// ГЕНЕРАТОР ИМЁН
// ═══════════════════════════════════════════

const FIRST_NAMES = [
  'Alex', 'Max', 'John', 'Mike', 'Chris', 'David', 'James', 'Daniel', 'Andrew', 'Ryan',
  'Emma', 'Olivia', 'Ava', 'Sophia', 'Mia', 'Isabella', 'Charlotte', 'Amelia', 'Harper', 'Evelyn',
  'Артём', 'Максим', 'Александр', 'Михаил', 'Иван', 'Дмитрий', 'Кирилл', 'Андрей', 'Егор', 'Никита',
  'Анна', 'Мария', 'Елена', 'Ольга', 'Наталья', 'Екатерина', 'Татьяна', 'Ирина', 'Светлана', 'Юлия',
  'Wei', 'Fang', 'Ming', 'Li', 'Chen', 'Wang', 'Zhang', 'Liu', 'Yang', 'Huang',
  'Yuki', 'Hana', 'Sakura', 'Kenji', 'Takeshi', 'Haruki', 'Ryu', 'Akira', 'Sora', 'Ren'
]

const LAST_NAMES = [
  'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez',
  'Иванов', 'Петров', 'Сидоров', 'Козлов', 'Новиков', 'Морозов', 'Волков', 'Соколов', 'Попов', 'Лебедев',
  'Wang', 'Li', 'Zhang', 'Liu', 'Chen', 'Yang', 'Huang', 'Zhao', 'Wu', 'Zhou',
  'Tanaka', 'Suzuki', 'Takahashi', 'Watanabe', 'Ito', 'Yamamoto', 'Nakamura', 'Kobayashi', 'Kato', 'Yoshida'
]

function randomElement<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

function generateUsername(index: number): string {
  const prefixes = ['user', 'player', 'trader', 'star', 'gift', 'bid', 'win', 'lucky', 'pro', 'mega']
  const prefix = randomElement(prefixes)
  return `${prefix}_${index}`
}

function generateAvatar(): string {
  // Генерируем URL на placeholder аватар
  const colors = ['red', 'blue', 'green', 'purple', 'orange', 'pink', 'cyan', 'yellow']
  const color = randomElement(colors)
  const id = Math.floor(Math.random() * 1000)
  return `https://api.dicebear.com/7.x/avataaars/svg?seed=${id}&backgroundColor=${color}`
}

// ═══════════════════════════════════════════
// BOT MANAGER
// ═══════════════════════════════════════════

class BotManager {
  private botIds: string[] = []
  private isRunning: boolean = false
  private bidInterval: NodeJS.Timeout | null = null
  private currentAuctionId: string | null = null
  
  // Stats
  private totalBidsPlaced: number = 0
  private bidsThisSecond: number = 0
  private lastSecondBids: number = 0
  private statsInterval: NodeJS.Timeout | null = null
  private successfulBids: number = 0
  private failedBids: number = 0
  private skippedNoBalance: number = 0

  // ═══════════════════════════════════════════
  // ГЕНЕРАЦИЯ БОТОВ (полноценные юзеры в БД)
  // ═══════════════════════════════════════════

  async generateBots(count: number, balance: number): Promise<{ created: number, time: number }> {
    const start = Date.now()
    
    console.log(`[BotManager] Generating ${count} bots with ${balance} stars each (PARALLEL)...`)

    // Получаем текущее количество ботов для offset
    const existingCount = await getBotsCount()
    
    // Параметры параллельной генерации
    const BATCH_SIZE = 10000    // 10k за batch (меньше для параллельности)
    const PARALLEL = 10         // 10 параллельных batch'ей
    
    const totalBatches = Math.ceil(count / BATCH_SIZE)
    let totalCreated = 0
    const allBotIds: string[] = []

    // Обрабатываем пачками по PARALLEL batch'ей
    for (let chunk = 0; chunk < Math.ceil(totalBatches / PARALLEL); chunk++) {
      const chunkStart = chunk * PARALLEL
      const chunkEnd = Math.min(chunkStart + PARALLEL, totalBatches)
      
      // Создаём промисы для параллельных batch'ей
      const promises = []
      
      for (let batch = chunkStart; batch < chunkEnd; batch++) {
        const batchStart = batch * BATCH_SIZE
        const batchSize = Math.min(BATCH_SIZE, count - batchStart)
        
        if (batchSize <= 0) continue
        
        promises.push(this.createBatch(existingCount + batchStart, batchSize, balance))
      }
      
      // Запускаем параллельно
      const results = await Promise.all(promises)
      
      // Собираем результаты
      for (const result of results) {
        totalCreated += result.created
        allBotIds.push(...result.botIds)
        
        // Добавляем в balanceManager
        for (const botId of result.botIds) {
          balanceManager.set(botId, balance)
        }
      }
      
      console.log(`[BotManager] Chunk ${chunk + 1}: ${totalCreated} bots created`)
    }

    // Добавляем все ID в массив
    this.botIds.push(...allBotIds)

    const time = Date.now() - start
    const speed = Math.round(totalCreated / (time / 1000))
    console.log(`[BotManager] Generated ${totalCreated} bots in ${time}ms (${speed} users/sec)`)

    return { created: totalCreated, time }
  }

  // Создание одного batch'а
  private async createBatch(startIndex: number, size: number, balance: number): Promise<{ created: number, botIds: string[] }> {
    const users = []
    const botIds: string[] = []
    
    for (let i = 0; i < size; i++) {
      const globalIndex = startIndex + i
      const botId = `bot_${globalIndex}`
      botIds.push(botId)
      
      users.push({
        id: botId,
        username: generateUsername(globalIndex),
        first_name: randomElement(FIRST_NAMES),
        last_name: Math.random() > 0.3 ? randomElement(LAST_NAMES) : undefined,
        avatar: generateAvatar(),
        balance: balance,
        is_bot: true,
        created_at: new Date()
      })
    }

    const created = await bulkCreateUsers(users)
    return { created, botIds }
  }

  // ═══════════════════════════════════════════
  // ЗАГРУЗКА СУЩЕСТВУЮЩИХ БОТОВ
  // ═══════════════════════════════════════════

  async loadExistingBots(): Promise<number> {
    console.log('[BotManager] Loading existing bots from DB...')
    const botIds = await getAllBotIds()
    this.botIds = botIds
    console.log(`[BotManager] Loaded ${botIds.length} bots`)
    return botIds.length
  }

  // ═══════════════════════════════════════════
  // ЗАПУСК БОТОВ
  // ═══════════════════════════════════════════

  start(auctionId: string, bidsPerSecond: number): { success: boolean, activeBots: number } {
    if (this.botIds.length === 0) {
      console.log('[BotManager] No bots available')
      return { success: false, activeBots: 0 }
    }

    const auction = auctionManager.getAuction(auctionId)
    if (!auction) {
      console.log('[BotManager] Auction not found')
      return { success: false, activeBots: 0 }
    }

    this.currentAuctionId = auctionId
    this.isRunning = true
    this.totalBidsPlaced = 0
    this.successfulBids = 0
    this.failedBids = 0
    this.skippedNoBalance = 0

    // Расчёт: сколько ставок за тик
    // 100 тиков в секунду, интервал 10ms, меньше ставок за тик
    const TICK_INTERVAL = 10
    const TICKS_PER_SECOND = 1000 / TICK_INTERVAL  // 100
    const BIDS_PER_TICK = Math.max(1, Math.ceil(bidsPerSecond / TICKS_PER_SECOND))

    console.log(`[BotManager] Starting ${this.botIds.length} bots: target ${bidsPerSecond} bids/sec (${BIDS_PER_TICK} per tick, ${TICK_INTERVAL}ms interval)`)

    // Основной цикл ставок
    this.bidInterval = setInterval(() => {
      if (!this.isRunning) return

      const auction = auctionManager.getAuction(this.currentAuctionId!)
      if (!auction || !auction.isRunning()) {
        console.log('[BotManager] Auction ended, stopping bots')
        this.stop()
        return
      }

      // Делаем BIDS_PER_TICK ставок за тик
      for (let i = 0; i < BIDS_PER_TICK; i++) {
        this.placeRandomBid(auction)
      }
    }, TICK_INTERVAL)

    // Статистика раз в секунду
    this.statsInterval = setInterval(() => {
      this.lastSecondBids = this.bidsThisSecond
      this.bidsThisSecond = 0
      
      if (this.lastSecondBids > 0 || this.skippedNoBalance > 0) {
        const skipRate = this.totalBidsPlaced > 0 
          ? Math.round(this.skippedNoBalance / (this.skippedNoBalance + this.totalBidsPlaced) * 100) 
          : 0
        console.log(`[BotManager] Stats: ${this.lastSecondBids} bids/sec, total: ${this.totalBidsPlaced}, skipped(no $): ${this.skippedNoBalance} (${skipRate}%)`)
      }
    }, 1000)

    return { success: true, activeBots: this.botIds.length }
  }

  // ═══════════════════════════════════════════
  // СЛУЧАЙНАЯ СТАВКА (в пределах баланса)
  // ═══════════════════════════════════════════

  private placeRandomBid(auction: Auction): void {
    const botId = this.botIds[Math.floor(Math.random() * this.botIds.length)]
    
    const currentBid = auction.getUserBid(botId)
    const balance = balanceManager.get(botId)
    const totalBudget = currentBid + balance
    
    // Нет свободного баланса для повышения
    if (balance <= 0) {
      this.skippedNoBalance++
      return
    }

    let bidAmount: number
    
    if (currentBid === 0) {
      // НОВАЯ СТАВКА - случайная 100-2000
      bidAmount = Math.floor(Math.random() * 1900) + 100
    } else {
      // ПОВЫШЕНИЕ - +100-500
      bidAmount = currentBid + Math.floor(Math.random() * 400) + 100
    }

    // Ограничиваем бюджетом
    if (bidAmount > totalBudget) {
      bidAmount = totalBudget
    }
    
    // Не можем повысить
    if (bidAmount <= currentBid) {
      this.skippedNoBalance++
      return
    }
    
    if (bidAmount - currentBid > balance) {
      this.skippedNoBalance++
      return
    }

    const result = auction.placeBid(botId, bidAmount)
    
    this.totalBidsPlaced++
    this.bidsThisSecond++
    
    if (result.success) {
      this.successfulBids++
    } else {
      this.failedBids++
    }
  }

  // ═══════════════════════════════════════════
  // ОСТАНОВКА
  // ═══════════════════════════════════════════

  stop(): void {
    this.isRunning = false
    
    if (this.bidInterval) {
      clearInterval(this.bidInterval)
      this.bidInterval = null
    }
    
    if (this.statsInterval) {
      clearInterval(this.statsInterval)
      this.statsInterval = null
    }

    console.log(`[BotManager] Stopped. Total bids: ${this.totalBidsPlaced}, successful: ${this.successfulBids}`)
  }

  // ═══════════════════════════════════════════
  // СТАТИСТИКА
  // ═══════════════════════════════════════════

  getStats(): {
    totalBots: number
    activeBots: number
    isRunning: boolean
    totalBids: number
    bidsPerSecond: number
    successRate: number
  } {
    return {
      totalBots: this.botIds.length,
      activeBots: this.isRunning ? this.botIds.length : 0,
      isRunning: this.isRunning,
      totalBids: this.totalBidsPlaced,
      bidsPerSecond: this.lastSecondBids,
      successRate: this.totalBidsPlaced > 0 
        ? Math.round(this.successfulBids / this.totalBidsPlaced * 100) 
        : 0
    }
  }

  // Очистка (для тестов)
  clear(): void {
    this.stop()
    this.botIds = []
    this.totalBidsPlaced = 0
    this.successfulBids = 0
    this.failedBids = 0
  }
}

export const botManager = new BotManager()