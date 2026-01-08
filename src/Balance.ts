import { BalanceRecord } from './types'

class BalanceManager {
  private balances: Map<string, number> = new Map()

  /**
   * Загрузить балансы из массива (из БД)
   */
  loadBalances(records: BalanceRecord[]): void {
    this.balances.clear()
    for (const record of records) {
      this.balances.set(record.user_id, record.balance)
    }
  }

  /**
   * Экспортировать балансы для записи в БД
   */
  exportBalances(): BalanceRecord[] {
    const result: BalanceRecord[] = []
    for (const [user_id, balance] of this.balances) {
      result.push({ user_id, balance })
    }
    return result
  }

  /**
   * Добавить к балансу
   */
  add(userId: string, amount: number): number {
    const current = this.balances.get(userId) ?? 0
    const newBalance = current + amount
    this.balances.set(userId, newBalance)
    return newBalance
  }

  /**
   * Убавить баланс. Возвращает false если недостаточно средств
   */
  remove(userId: string, amount: number): boolean {
    const current = this.balances.get(userId) ?? 0
    if (current < amount) {
      return false
    }
    this.balances.set(userId, current - amount)
    return true
  }

  /**
   * Получить баланс пользователя
   */
  get(userId: string): number {
    return this.balances.get(userId) ?? 0
  }

  /**
   * Проверить существует ли пользователь
   */
  has(userId: string): boolean {
    return this.balances.has(userId)
  }

  /**
   * Создать пользователя с начальным балансом
   */
  create(userId: string, initialBalance: number = 0): void {
    if (!this.balances.has(userId)) {
      this.balances.set(userId, initialBalance)
    }
  }

  /**
   * Установить баланс напрямую
   */
  set(userId: string, balance: number): void {
    this.balances.set(userId, balance)
  }

  /**
   * Количество пользователей
   */
  count(): number {
    return this.balances.size
  }

  /**
   * Очистить все балансы
   */
  clear(): void {
    this.balances.clear()
  }
}

// Singleton
export const balanceManager = new BalanceManager()