export interface User {
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

export interface Bid {
  userId: string
  amount: number
  timestamp: number
}

export interface RoundPlan {
  round_number: number
  count_of_gifts: number
  time: number  // в секундах
}

export interface Winner {
  user_id: string
  stars: number
  gift_number: number
}

export interface Gift {
  id: string
  name: string
  // можно расширить
}

export interface Auction {
  _id: string
  name: string
  gift: Gift
  plan: RoundPlan[]
  winners: Winner[]
  status: 'pending' | 'active' | 'finished'
  created_at: Date
  finished_at?: Date
}

export interface BidResult {
  success: boolean
  error?: string
  newBid?: number
}

export interface BalanceRecord {
  user_id: string
  balance: number
}