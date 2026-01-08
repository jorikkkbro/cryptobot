import { RoundPlan, Winner, Gift, BidResult, BalanceRecord } from './types'
import { balanceManager } from './Balance'
import { loadBalances, saveBalances } from './mongo'
import mongoose, { Schema, Document } from 'mongoose'

// ═══════════════════════════════════════════
// MONGODB СХЕМА АУКЦИОНА
// ═══════════════════════════════════════════

interface IAuction extends Document {
  name: string
  gift: Gift
  plan: RoundPlan[]
  winners: Winner[]
  status: 'pending' | 'active' | 'finished'
  created_at: Date
  finished_at?: Date
}

const AuctionSchema = new Schema<IAuction>({
  name: { type: String, required: true },
  gift: {
    id: { type: String, required: true },
    name: { type: String, required: true }
  },
  plan: [{
    round_number: { type: Number, required: true },
    count_of_gifts: { type: Number, required: true },
    time: { type: Number, required: true }  // секунды
  }],
  winners: [{
    user_id: { type: String, required: true },
    stars: { type: Number, required: true },
    gift_number: { type: Number, required: true }
  }],
  status: { type: String, enum: ['pending', 'active', 'finished'], default: 'pending' },
  created_at: { type: Date, default: Date.now },
  finished_at: { type: Date }
})

export const AuctionModel = mongoose.model<IAuction>('Auction', AuctionSchema)

// ═══════════════════════════════════════════
// IN-MEMORY СТАВКА
// ═══════════════════════════════════════════

interface Bid {
  userId: string
  amount: number
  timestamp: number
}

// ═══════════════════════════════════════════
// КЛАСС АУКЦИОНА
// ═══════════════════════════════════════════

export class Auction {
  private auctionId: string
  private name: string
  private gift: Gift
  private plan: RoundPlan[]
  
  private currentRound: number = 0
  private bids: Map<string, Bid> = new Map()
  private sortedCache: Bid[] | null = null
  
  private roundEndTime: number = 0
  private roundTimer: NodeJS.Timeout | null = null
  
  private isActive: boolean = false

  // Callbacks
  public onRoundEnd: ((roundNumber: number, winners: Winner[]) => void) | null = null
  public onAuctionEnd: (() => void) | null = null

  constructor(auctionId: string, name: string, gift: Gift, plan: RoundPlan[]) {
    this.auctionId = auctionId
    this.name = name
    this.gift = gift
    this.plan = plan
  }

  // ═══════════════════════════════════════════
  // GETTERS
  // ═══════════════════════════════════════════

  getId(): string { return this.auctionId }
  getName(): string { return this.name }
  getGift(): Gift { return this.gift }
  getCurrentRound(): number { return this.currentRound }
  isRunning(): boolean { return this.isActive }
  
  getRoundEndTime(): number { return this.roundEndTime }
  getTimeRemaining(): number {
    return Math.max(0, this.roundEndTime - Date.now())
  }

  getCurrentRoundPlan(): RoundPlan | null {
    return this.plan[this.currentRound] ?? null
  }

  getTotalGifts(): number {
    return this.plan.reduce((sum, r) => sum + r.count_of_gifts, 0)
  }

  getGiftsAwarded(): number {
    let count = 0
    for (let i = 0; i < this.currentRound; i++) {
      count += this.plan[i].count_of_gifts
    }
    return count
  }

  // ═══════════════════════════════════════════
  // START ROUND
  // ═══════════════════════════════════════════

  async startRound(): Promise<void> {
    if (this.currentRound >= this.plan.length) {
      await this.endAuction()
      return
    }

    // 1. Загружаем балансы из БД (snapshot)
    const records = await loadBalances()
    balanceManager.loadBalances(records)
    console.log(`[Auction ${this.name}] Round ${this.currentRound + 1} starting, loaded ${balanceManager.count()} balances`)

    // 2. Если не первый раунд — переносим ставки проигравших
    // (они уже в памяти с прошлого раунда)
    // Чистим только если это первый раунд
    if (this.currentRound === 0) {
      this.bids.clear()
    }
    this.sortedCache = null

    // 3. Устанавливаем таймер раунда
    const roundDuration = this.plan[this.currentRound].time * 1000
    this.roundEndTime = Date.now() + roundDuration
    this.isActive = true

    // 4. Обновляем статус в БД
    await AuctionModel.updateOne(
      { _id: this.auctionId },
      { $set: { status: 'active' } }
    )

    // 5. Запускаем таймер
    this.scheduleRoundEnd()
    
    console.log(`[Auction ${this.name}] Round ${this.currentRound + 1} started, duration: ${this.plan[this.currentRound].time}s`)
  }

  private scheduleRoundEnd(): void {
    if (this.roundTimer) {
      clearTimeout(this.roundTimer)
    }

    const remaining = this.roundEndTime - Date.now()
    if (remaining <= 0) {
      this.endRound()
    } else {
      this.roundTimer = setTimeout(() => this.endRound(), remaining)
    }
  }

  // Anti-snipe: продление только при выталкивании из топа
  private readonly ANTI_SNIPE_WINDOW = 5   // последние 5 секунд
  private readonly ANTI_SNIPE_EXTEND = 10  // продлить на 10 секунд

  // ═══════════════════════════════════════════
  // PLACE BID (синхронно!)
  // ═══════════════════════════════════════════

  placeBid(userId: string, amount: number): BidResult {
    if (!this.isActive) {
      return { success: false, error: 'Аукцион не активен' }
    }

    if (amount <= 0) {
      return { success: false, error: 'Сумма должна быть положительной' }
    }

    const currentBid = this.bids.get(userId)?.amount ?? 0
    
    if (amount <= currentBid) {
      return { success: false, error: `Ставка должна быть выше текущей (${currentBid})` }
    }

    const needed = amount - currentBid
    const balance = balanceManager.get(userId)

    if (balance < needed) {
      return { success: false, error: `Недостаточно средств. Нужно: ${needed}, баланс: ${balance}` }
    }

    // Проверяем anti-snipe ДО применения ставки
    const remaining = this.roundEndTime - Date.now()
    const isLastSeconds = remaining > 0 && remaining < this.ANTI_SNIPE_WINDOW * 1000
    
    // Получаем текущий минимум для прохода
    const roundPlan = this.plan[this.currentRound]
    const winnersCount = roundPlan?.count_of_gifts ?? 0
    const sorted = this.getSortedBids()
    const currentMinWinning = sorted.length >= winnersCount 
      ? sorted[winnersCount - 1]?.amount ?? 0 
      : 0

    // Всё синхронно — race condition невозможен
    balanceManager.remove(userId, needed)
    this.bids.set(userId, { userId, amount, timestamp: Date.now() })
    this.sortedCache = null

    // Anti-snipe: если в последние 5 сек и ставка выталкивает кого-то из топа
    if (isLastSeconds && amount > currentMinWinning && currentMinWinning > 0) {
      this.roundEndTime = Date.now() + this.ANTI_SNIPE_EXTEND * 1000
      this.scheduleRoundEnd()
      console.log(`[Auction ${this.name}] Anti-snipe! Bid ${amount} > ${currentMinWinning}, extended +${this.ANTI_SNIPE_EXTEND}s`)
    }

    return { success: true, newBid: amount }
  }

  // ═══════════════════════════════════════════
  // END ROUND
  // ═══════════════════════════════════════════

  private async endRound(): Promise<void> {
    if (!this.isActive) return
    
    console.log(`[Auction ${this.name}] Round ${this.currentRound + 1} ending...`)

    const roundPlan = this.plan[this.currentRound]
    const winnersCount = roundPlan.count_of_gifts

    // 1. Сортируем ставки
    const sorted = this.getSortedBids()
    const winners = sorted.slice(0, winnersCount)
    // losers остаются в bids — их ставки переносятся!

    // 2. Определяем gift_number для победителей
    const giftNumberOffset = this.getGiftsAwarded()
    const winnersData: Winner[] = winners.map((bid, i) => ({
      user_id: bid.userId,
      stars: bid.amount,
      gift_number: giftNumberOffset + i + 1
    }))

    // 3. Удаляем ТОЛЬКО победителей из списка ставок
    // Проигравшие остаются — их ставки переносятся в следующий раунд!
    for (const winner of winners) {
      this.bids.delete(winner.userId)
    }
    this.sortedCache = null

    // 4. Сохраняем в БД
    await this.commitRound(winnersData)

    // 5. Callback
    if (this.onRoundEnd) {
      this.onRoundEnd(this.currentRound, winnersData)
    }

    console.log(`[Auction ${this.name}] Round ${this.currentRound + 1} ended, ${winnersData.length} winners, ${this.bids.size} bids carry over`)

    // 6. Следующий раунд или конец
    this.currentRound++
    
    if (this.currentRound < this.plan.length) {
      // Сразу следующий раунд
      await this.startRound()
    } else {
      await this.endAuction()
    }
  }

  // ═══════════════════════════════════════════
  // COMMIT TO DB
  // ═══════════════════════════════════════════

  private async commitRound(winners: Winner[]): Promise<void> {
    // Сохраняем только победителей (быстро, ~5 записей)
    await AuctionModel.updateOne(
      { _id: this.auctionId },
      { $push: { winners: { $each: winners } } }
    )

    // НЕ сохраняем все балансы — это делается только в конце аукциона
    // Балансы в памяти актуальны

    console.log(`[Auction ${this.name}] Committed: ${winners.length} winners`)
  }

  // ═══════════════════════════════════════════
  // END AUCTION
  // ═══════════════════════════════════════════

  private async endAuction(): Promise<void> {
    this.isActive = false
    
    if (this.roundTimer) {
      clearTimeout(this.roundTimer)
      this.roundTimer = null
    }

    // Возвращаем оставшиеся ставки
    for (const [userId, bid] of this.bids) {
      balanceManager.add(userId, bid.amount)
    }
    this.bids.clear()

    // Сохраняем финальные балансы
    const balanceRecords = balanceManager.exportBalances()
    await saveBalances(balanceRecords)

    // Обновляем статус
    await AuctionModel.updateOne(
      { _id: this.auctionId },
      { $set: { status: 'finished', finished_at: new Date() } }
    )

    console.log(`[Auction ${this.name}] Auction finished!`)

    if (this.onAuctionEnd) {
      this.onAuctionEnd()
    }
  }

  // ═══════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════

  private getSortedBids(): Bid[] {
    if (!this.sortedCache) {
      this.sortedCache = [...this.bids.values()].sort((a, b) => {
        // По убыванию суммы
        if (b.amount !== a.amount) return b.amount - a.amount
        // При равенстве — кто раньше поставил
        return a.timestamp - b.timestamp
      })
    }
    return this.sortedCache
  }

  // Публичный метод для API
  getLeaderboard(limit: number = 50): { userId: string, amount: number, position: number }[] {
    const sorted = this.getSortedBids()
    return sorted.slice(0, limit).map((bid, i) => ({
      userId: bid.userId,
      amount: bid.amount,
      position: i + 1
    }))
  }

  getUserBid(userId: string): number {
    return this.bids.get(userId)?.amount ?? 0
  }

  getBidsCount(): number {
    return this.bids.size
  }

  // Минимальная ставка чтобы попасть в победители текущего раунда
  getMinWinningBid(): number {
    const roundPlan = this.plan[this.currentRound]
    if (!roundPlan) return 0

    const sorted = this.getSortedBids()
    if (sorted.length < roundPlan.count_of_gifts) {
      return 1  // любая ставка выиграет
    }

    // Ставка последнего победителя + 1
    return sorted[roundPlan.count_of_gifts - 1].amount + 1
  }
}

// ═══════════════════════════════════════════
// AUCTION MANAGER (singleton)
// ═══════════════════════════════════════════

class AuctionManager {
  private activeAuctions: Map<string, Auction> = new Map()

  async createAuction(name: string, gift: Gift, plan: RoundPlan[]): Promise<Auction> {
    // Создаём в БД
    const doc = await AuctionModel.create({
      name,
      gift,
      plan,
      winners: [],
      status: 'pending'
    })

    // Создаём in-memory
    const auction = new Auction(doc._id.toString(), name, gift, plan)
    this.activeAuctions.set(doc._id.toString(), auction)

    console.log(`[AuctionManager] Created auction: ${name}`)

    return auction
  }

  getAuction(auctionId: string): Auction | null {
    return this.activeAuctions.get(auctionId) ?? null
  }

  getAllAuctions(): Auction[] {
    return [...this.activeAuctions.values()]
  }

  removeAuction(auctionId: string): void {
    this.activeAuctions.delete(auctionId)
  }

  // Восстановление после краша
  async recoverFromDB(): Promise<void> {
    const activeAuctions = await AuctionModel.find({ status: 'active' })
    
    for (const doc of activeAuctions) {
      console.log(`[AuctionManager] Recovering auction: ${doc.name}`)
      
      // Определяем текущий раунд по количеству winners
      let winnersCount = doc.winners.length
      let currentRound = 0
      
      for (let i = 0; i < doc.plan.length; i++) {
        if (winnersCount <= 0) break
        winnersCount -= doc.plan[i].count_of_gifts
        currentRound = i + 1
      }

      const auction = new Auction(doc._id.toString(), doc.name, doc.gift, doc.plan)
      this.activeAuctions.set(doc._id.toString(), auction)
      
      // Рестартуем текущий раунд
      await auction.startRound()
    }
  }
}

export const auctionManager = new AuctionManager()