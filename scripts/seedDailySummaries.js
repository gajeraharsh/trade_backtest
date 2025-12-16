require('dotenv').config();
const mongoose = require('mongoose');
const Candle = require('../models/Candle');
const DailySummary = require('../models/DailySummary');

// MongoDB connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/trade';

/**
 * Seed script to calculate and store daily summaries from Candle collection
 * Run with: node scripts/seedDailySummaries.js
 */
async function seedDailySummaries() {
  try {
    // Connect to MongoDB
    console.log('Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    // Fetch all candles grouped by securityId
    console.log('\n📊 Fetching candles from database...');
    const candles = await Candle.find({}).sort({ timestamp: 1 }).lean();
    console.log(`✅ Found ${candles.length} candles`);

    if (candles.length === 0) {
      console.log('⚠️  No candles found in database. Please fetch some historical data first.');
      await mongoose.disconnect();
      return;
    }

    // Group candles by securityId and date
    console.log('\n🔄 Grouping candles by date and securityId...');
    const candlesByDateAndSecurity = {};

    candles.forEach(candle => {
      const date = new Date(candle.timestamp);
      // Get date string in YYYY-MM-DD format
      const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      const securityKey = `${candle.securityId}_${dateKey}`;

      if (!candlesByDateAndSecurity[securityKey]) {
        candlesByDateAndSecurity[securityKey] = {
          stockName: candle.stockName,
          securityId: candle.securityId,
          date: new Date(date.getFullYear(), date.getMonth(), date.getDate()), // Start of day
          candles: []
        };
      }
      candlesByDateAndSecurity[securityKey].candles.push(candle);
    });

    console.log(`✅ Grouped into ${Object.keys(candlesByDateAndSecurity).length} unique date/security combinations`);

    // Calculate daily summaries
    console.log('\n📈 Calculating daily summaries...');
    const dailySummaries = [];

    Object.keys(candlesByDateAndSecurity).forEach(key => {
      const { stockName, securityId, date, candles: dayCandles } = candlesByDateAndSecurity[key];
      
      // Sort candles by timestamp to get first and last
      dayCandles.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

      // Calculate metrics
      const dailyHigh = Math.max(...dayCandles.map(c => c.high));
      const dailyLow = Math.min(...dayCandles.map(c => c.low));
      const open = dayCandles[0].open; // First candle's open
      const close = dayCandles[dayCandles.length - 1].close; // Last candle's close
      const totalVolume = dayCandles.reduce((sum, c) => sum + (c.volume || 0), 0);

      dailySummaries.push({
        stockName,
        securityId,
        date,
        dailyHigh: parseFloat(dailyHigh),
        dailyLow: parseFloat(dailyLow),
        open: parseFloat(open),
        close: parseFloat(close),
        totalVolume: parseInt(totalVolume)
      });
    });

    console.log(`✅ Calculated ${dailySummaries.length} daily summaries`);

    // Save daily summaries with duplicate handling
    console.log('\n💾 Saving daily summaries to database...');
    let savedCount = 0;
    let duplicateCount = 0;

    try {
      const result = await DailySummary.insertMany(dailySummaries, {
        ordered: false, // Continue inserting even if some fail
        rawResult: false
      });
      savedCount = result.length;
      console.log(`✅ Successfully inserted ${savedCount} daily summaries`);
    } catch (error) {
      // Handle bulk write errors (duplicates)
      if (error.name === 'BulkWriteError' && error.writeErrors) {
        savedCount = error.result?.insertedCount || 0;
        duplicateCount = error.writeErrors.length;
        console.log(`✅ Inserted ${savedCount} new daily summaries`);
        console.log(`⚠️  Skipped ${duplicateCount} duplicates (already exist)`);
      } else {
        throw error;
      }
    }

    // Summary
    console.log('\n📊 Summary:');
    console.log(`   Total candles processed: ${candles.length}`);
    console.log(`   Unique date/security combinations: ${dailySummaries.length}`);
    console.log(`   New daily summaries saved: ${savedCount}`);
    if (duplicateCount > 0) {
      console.log(`   Duplicates skipped: ${duplicateCount}`);
    }

    // Disconnect
    await mongoose.disconnect();
    console.log('\n✅ Seed completed successfully!');
    process.exit(0);

  } catch (error) {
    console.error('\n❌ Error seeding daily summaries:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

// Run the seed function
seedDailySummaries();

