import Redis from 'ioredis';

const redisUrl = process.env.REDIS_URL || 'redis://default:AdbSAAIncDEzZDU5MDQ4ODNhYmU0MGY0OWU0OWFkZjMyZGY2MmVhNXAxNTQ5OTQ@firm-falcon-54994.upstash.io:6379';
console.log(`Connecting to Redis at ${redisUrl}`);

const redisConnection = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
  retryStrategy(times) {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  reconnectOnError(err) {
    const targetError = 'READONLY';
    if (err.message.includes(targetError)) {
      // Only reconnect when the error contains "READONLY"
      return true;
    }
    return false;
  },
});

redisConnection.on('error', (error) => {
  console.error('Redis connection error:', error);
});

redisConnection.on('connect', () => {
  console.log('Successfully connected to Redis');
});

export default redisConnection;