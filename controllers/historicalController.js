const axios = require('axios');
const Candle = require('../models/Candle');

/**
 * Render the historical data form page
 */
exports.getHistoricalForm = (req, res) => {
  res.render('historical', { 
    title: 'Fetch Historical Stock Data',
    error: null,
    success: null
  });
};

/**
 * Fetch historical data from Dhan API and store in MongoDB
 * Handles 90-day chunking for intraday intervals
 */
exports.fetchAndStoreHistorical = async (req, res) => {
  try {
    const { stockName, securityId, interval, startDate, endDate } = req.body;

    // Validation
    if (!stockName || !securityId || !interval || !startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: 'All fields are required'
      });
    }

    // Validate date range
    const start = new Date(startDate);
    const end = new Date(endDate);
    
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).json({
        success: false,
        message: 'Invalid date format'
      });
    }

    if (start >= end) {
      return res.status(400).json({
        success: false,
        message: 'End date must be after start date'
      });
    }

    // Check environment variables
    const accessToken = process.env.DHAN_ACCESS_TOKEN;
    const clientId = process.env.DHAN_CLIENT_ID;

    if (!accessToken || !clientId) {
      return res.status(500).json({
        success: false,
        message: 'Dhan API credentials not configured. Please set DHAN_ACCESS_TOKEN and DHAN_CLIENT_ID in .env file'
      });
    }

    // Fetch data with chunking for intraday intervals
    const allCandles = await fetchHistoricalDataWithChunking(
      securityId,
      interval,
      start,
      end,
      accessToken,
      clientId
    );

    console.log('allCandles', allCandles);

    if (allCandles.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No data found for the given parameters'
      });
    }

    // Prepare candles for bulk insert
    const candlesToInsert = allCandles.map(candle => ({
      stockName,
      securityId,
      interval,
      // Convert Unix timestamp (seconds) to JavaScript Date (milliseconds)
      timestamp: new Date(candle.start_Time * 1000),
      open: parseFloat(candle.open),
      high: parseFloat(candle.high),
      low: parseFloat(candle.low),
      close: parseFloat(candle.close),
      volume: parseInt(candle.volume) || 0
    }));

    // Bulk insert with duplicate handling
    const savedCount = await saveCandlesBulk(candlesToInsert);

    res.json({
      success: true,
      message: `Successfully stored ${savedCount} candles`,
      totalFetched: allCandles.length,
      saved: savedCount
    });

  } catch (error) {
    console.error('Error fetching historical data:', error);
    
    // Handle specific error types
    if (error.response) {
      // API error response
      return res.status(error.response.status || 500).json({
        success: false,
        message: error.response.data?.message || 'Dhan API error',
        details: error.response.data
      });
    }

    if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
      return res.status(503).json({
        success: false,
        message: 'Unable to connect to Dhan API. Please check your internet connection.'
      });
    }

    res.status(500).json({
      success: false,
      message: error.message || 'Internal server error'
    });
  }
};

/**
 * Fetch historical data with 90-day chunking for intraday intervals
 * Dhan API limits intraday data to 90 days per request
 */
async function fetchHistoricalDataWithChunking(
  securityId,
  interval,
  startDate,
  endDate,
  accessToken,
  clientId
) {
  const allCandles = [];
  const chunkSize = 90; // 90 days max for intraday
  const oneDay = 24 * 60 * 60 * 1000; // milliseconds in a day

  let currentStart = new Date(startDate);
  const finalEnd = new Date(endDate);

  while (currentStart < finalEnd) {
    // Calculate chunk end date (90 days from current start or final end, whichever is earlier)
    const chunkEnd = new Date(currentStart);
    chunkEnd.setDate(chunkEnd.getDate() + chunkSize - 1);
    
    const actualEnd = chunkEnd > finalEnd ? finalEnd : chunkEnd;

    try {
      const candles = await fetchHistoricalDataChunk(
        securityId,
        interval,
        currentStart,
        actualEnd,
        accessToken,
        clientId
      );

      if (candles && candles.length > 0) {
        allCandles.push(...candles);
      }

      // Move to next chunk
      currentStart = new Date(actualEnd);
      currentStart.setDate(currentStart.getDate() + 1);

      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));

    } catch (error) {
      console.log('error', error);
      // Enhanced error logging
      if (error.response) {
        console.error(`\n❌ Dhan API Error (${error.response.status}) for chunk ${currentStart.toISOString().split('T')[0]} to ${actualEnd.toISOString().split('T')[0]}:`);
        console.error('Error Details:', JSON.stringify(error.response.data, null, 2));
        console.error('Request URL:', error.config?.url);
        if (error.config?.data) {
          console.error('Request Body:', JSON.stringify(JSON.parse(error.config.data), null, 2));
        }
        if (error.config?.params) {
          console.error('Request Params:', JSON.stringify(error.config.params, null, 2));
        }
      } else {
        console.error(`Error fetching chunk from ${currentStart} to ${actualEnd}:`, error.message);
      }
      // Continue with next chunk even if one fails
      currentStart = new Date(actualEnd);
      currentStart.setDate(currentStart.getDate() + 1);
    }
  }

  // Remove duplicates (in case of overlap)
  const uniqueCandles = removeDuplicateCandles(allCandles);

  return uniqueCandles;
}

/**
 * Fetch a single chunk of historical data from Dhan API
 */
async function fetchHistoricalDataChunk(
  securityId,
  interval,
  startDate,
  endDate,
  accessToken,
  clientId
) {
  const apiUrl = 'https://api.dhan.co/v2/charts/intraday';

  // Format dates as YYYY-MM-DD
  const formatDate = (date) => {
    const d = new Date(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  // Dhan API expects camelCase parameters in request body (POST) or query params (GET)
  // Based on the example, using camelCase format
  const requestBody = {
    securityId: securityId,
    exchangeSegment: 'NSE_EQ', // Default to NSE Equity, can be made configurable
    instrument: 'EQUITY',
    expiryCode: 0,
    fromDate: formatDate(startDate),
    toDate: formatDate(endDate),
    interval: interval,
    oi: false // Open Interest flag
  };

  const headers = {
    'access-token': accessToken,
    'client-id': clientId,
    'Content-Type': 'application/json'
  };

  // Try POST request first (as Dhan API typically uses POST for complex queries)
  try {
    const response = await axios.post(apiUrl, requestBody, {
      headers,
      timeout: 30000 // 30 seconds timeout
    });

    // Dhan API returns data in array format: { data: { open: [], high: [], low: [], close: [], volume: [], timestamp: [] } }
    const apiData = response.data?.data || response.data;
    
    // Transform array format to candle objects
    return transformArrayDataToCandles(apiData);
  } catch (postError) {
    // If POST fails, try GET with query parameters
    if (postError.response?.status === 405 || postError.response?.status === 400) {
      console.log('POST failed, trying GET with query parameters...');
      const response = await axios.get(apiUrl, {
        params: requestBody,
        headers,
        timeout: 30000
      });
      const apiData = response.data?.data || response.data;
      return transformArrayDataToCandles(apiData);
    }
    throw postError;
  }
}

/**
 * Transform Dhan API array format to candle objects
 * API returns: { open: [], high: [], low: [], close: [], volume: [], timestamp: [] }
 * Converts to: [{ start_Time, open, high, low, close, volume }, ...]
 */
function transformArrayDataToCandles(apiData) {
  // If apiData is already an array of objects, return as is
  if (Array.isArray(apiData) && apiData.length > 0 && typeof apiData[0] === 'object' && !Array.isArray(apiData[0].open)) {
    return apiData;
  }

  // If apiData is null, undefined, or empty, return empty array
  if (!apiData || typeof apiData !== 'object') {
    return [];
  }

  // Check if data is in array format (has open, high, low, close, volume, timestamp arrays)
  const { open, high, low, close, volume, timestamp } = apiData;

  if (!Array.isArray(open) || !Array.isArray(high) || !Array.isArray(low) || !Array.isArray(close) || !Array.isArray(timestamp)) {
    // If not in expected format, return empty array or try to return as is
    return Array.isArray(apiData) ? apiData : [];
  }

  // Get the length (all arrays should have same length)
  const length = Math.min(
    open.length,
    high.length,
    low.length,
    close.length,
    timestamp.length,
    volume ? volume.length : Infinity
  );

  // Transform arrays into candle objects
  const candles = [];
  for (let i = 0; i < length; i++) {
    candles.push({
      start_Time: timestamp[i], // Unix timestamp in seconds
      open: open[i],
      high: high[i],
      low: low[i],
      close: close[i],
      volume: volume && volume[i] ? volume[i] : 0
    });
  }

  return candles;
}

/**
 * Remove duplicate candles based on timestamp
 */
function removeDuplicateCandles(candles) {
  const seen = new Set();
  return candles.filter(candle => {
    const key = candle.start_Time || candle.timestamp;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/**
 * Save candles in bulk, skipping duplicates
 * Uses insertMany with ordered: false to continue on duplicate key errors
 */
async function saveCandlesBulk(candlesToInsert) {
  if (candlesToInsert.length === 0) {
    return 0;
  }

  try {
    // Use insertMany with ordered: false to skip duplicates
    const result = await Candle.insertMany(candlesToInsert, {
      ordered: false, // Continue inserting even if some fail
      rawResult: false
    });

    return result.length;

  } catch (error) {
    // Handle bulk write errors (duplicates)
    if (error.name === 'BulkWriteError' && error.writeErrors) {
      // Count successful inserts
      const insertedCount = error.result?.insertedCount || 0;
      const duplicateCount = error.writeErrors.length;

      console.log(`Inserted ${insertedCount} candles, skipped ${duplicateCount} duplicates`);
      return insertedCount;
    }

    // Re-throw if it's a different error
    throw error;
  }
}

