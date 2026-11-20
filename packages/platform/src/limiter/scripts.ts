/** Sliding-window log: exact "at most N in any window" using Redis time (identical on every api/worker copy). */
export const SLIDING_WINDOW_LUA = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
local count = redis.call('ZCARD', KEYS[1])
if count >= limit then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  return {0, count, tonumber(oldest[2]) + window - now}
end
redis.call('ZADD', KEYS[1], now, ARGV[3])
redis.call('PEXPIRE', KEYS[1], window)
return {1, count + 1, 0}
`;

/**
 * Slot scheduler: hands out evenly spaced send times (one per 1000/rate ms) to every caller on every copy.
 * Callers wait for their slot, so calls arrive spread out instead of in bursts. Returns the wait in ms.
 */
export const SLOT_LUA = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local interval = tonumber(ARGV[1])
local last = tonumber(redis.call('GET', KEYS[1]) or '0')
local slot = math.max(now, last + interval)
redis.call('SET', KEYS[1], tostring(slot), 'PX', 60000)
return {slot - now}
`;

/** Fixed window counter. The TTL is always (re)set so a key can never live forever. */
export const FIXED_WINDOW_LUA = `
local c = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if c == 1 or ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  ttl = tonumber(ARGV[2])
end
local allowed = 0
if c <= tonumber(ARGV[1]) then allowed = 1 end
return {allowed, c, ttl}
`;
