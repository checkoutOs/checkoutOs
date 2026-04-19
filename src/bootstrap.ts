import dotenv from 'dotenv';
import path from 'path';

const result = dotenv.config({
  path: path.resolve(process.cwd(), '.env'),
});

if (result.error) {
  console.warn('⚠️ .env file not found or failed to load');
} else {
  console.log('✅ Environment variables loaded');
}
