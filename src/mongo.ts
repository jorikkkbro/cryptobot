import mongoose, { Schema, Document } from 'mongoose'
import { BalanceRecord, User } from './types'

// ═══════════════════════════════════════════
// USER SCHEMA
// ═══════════════════════════════════════════

export interface IUser extends Document {
  id: string
  username: string
  first_name: string
  last_name?: string
  avatar?: string
  balance: number
  is_bot: boolean
  created_at: Date
  last_active_at: Date
}

const UserSchema = new Schema<IUser>({
  id: { type: String, required: true, unique: true, index: true },
  username: { type: String, required: true, index: true },
  first_name: { type: String, required: true },
  last_name: { type: String },
  avatar: { type: String },
  balance: { type: Number, required: true, default: 0 },
  is_bot: { type: Boolean, default: false },
  created_at: { type: Date, default: Date.now },
  last_active_at: { type: Date, default: Date.now }
})

export const UserModel = mongoose.model<IUser>('User', UserSchema)

// ═══════════════════════════════════════════
// ПОДКЛЮЧЕНИЕ
// ═══════════════════════════════════════════

export async function connectDB(uri: string): Promise<void> {
  await mongoose.connect(uri)
  console.log('MongoDB connected')
}

export async function disconnectDB(): Promise<void> {
  await mongoose.disconnect()
  console.log('MongoDB disconnected')
}

// ═══════════════════════════════════════════
// USERS
// ═══════════════════════════════════════════

/**
 * Создать юзера
 */
export async function createUser(user: Partial<User> & { id: string }): Promise<IUser> {
  const doc = await UserModel.create({
    id: user.id,
    username: user.username || user.id,
    first_name: user.first_name || user.id,
    last_name: user.last_name,
    avatar: user.avatar,
    balance: user.balance ?? 0,
    is_bot: user.is_bot ?? false,
    created_at: user.created_at || new Date(),
    last_active_at: new Date()
  })
  return doc
}

/**
 * Получить юзера по ID
 */
export async function getUser(userId: string): Promise<IUser | null> {
  return UserModel.findOne({ id: userId }).lean()
}

/**
 * Bulk создание юзеров (для миллионов)
 */
export async function bulkCreateUsers(users: Array<Partial<User> & { id: string }>): Promise<number> {
  if (users.length === 0) return 0

  const docs = users.map(user => ({
    id: user.id,
    username: user.username || user.id,
    first_name: user.first_name || user.id,
    last_name: user.last_name,
    avatar: user.avatar,
    balance: user.balance ?? 0,
    is_bot: user.is_bot ?? false,
    created_at: user.created_at || new Date(),
    last_active_at: new Date()
  }))

  // insertMany с ordered: false для максимальной скорости
  // Игнорируем дубликаты
  try {
    const result = await UserModel.insertMany(docs, { ordered: false })
    return result.length
  } catch (err: any) {
    // Если есть дубликаты, MongoDB выбросит BulkWriteError
    // но остальные записи всё равно вставятся
    if (err.insertedDocs) {
      return err.insertedDocs.length
    }
    return 0
  }
}

/**
 * Получить количество юзеров
 */
export async function getUsersCount(): Promise<number> {
  return UserModel.countDocuments()
}

/**
 * Получить количество ботов
 */
export async function getBotsCount(): Promise<number> {
  return UserModel.countDocuments({ is_bot: true })
}

/**
 * Получить все ID ботов
 */
export async function getAllBotIds(): Promise<string[]> {
  const bots = await UserModel.find({ is_bot: true }).select('id').lean()
  return bots.map(b => b.id)
}

// ═══════════════════════════════════════════
// БАЛАНСЫ (работают с User)
// ═══════════════════════════════════════════

/**
 * Загрузить все балансы из БД
 */
export async function loadBalances(): Promise<BalanceRecord[]> {
  const docs = await UserModel.find({}).select('id balance').lean()
  return docs.map(doc => ({
    user_id: doc.id,
    balance: doc.balance
  }))
}

/**
 * Сохранить балансы в БД (bulk update)
 */
export async function saveBalances(records: BalanceRecord[]): Promise<void> {
  if (records.length === 0) return

  const bulkOps = records.map(record => ({
    updateOne: {
      filter: { id: record.user_id },
      update: { $set: { balance: record.balance, last_active_at: new Date() } }
    }
  }))

  await UserModel.bulkWrite(bulkOps, { ordered: false })
}

/**
 * Получить баланс одного пользователя из БД
 */
export async function getBalanceFromDB(userId: string): Promise<number> {
  const doc = await UserModel.findOne({ id: userId }).select('balance').lean()
  return doc?.balance ?? 0
}

/**
 * Установить баланс пользователя в БД
 */
export async function setBalanceInDB(userId: string, balance: number): Promise<void> {
  await UserModel.updateOne(
    { id: userId },
    { $set: { balance, last_active_at: new Date() } }
  )
}

/**
 * Инкремент баланса в БД
 */
export async function incrementBalanceInDB(userId: string, amount: number): Promise<number> {
  const result = await UserModel.findOneAndUpdate(
    { id: userId },
    { $inc: { balance: amount }, $set: { last_active_at: new Date() } },
    { new: true }
  )
  return result?.balance ?? 0
}