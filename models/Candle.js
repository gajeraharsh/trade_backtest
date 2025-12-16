const mongoose = require('mongoose');

/**
 * Candle Schema for storing historical stock data
 * Prevents duplicates using compound index on securityId + interval + timestamp
 */
const candleSchema = new mongoose.Schema({
  stockName: {
    type: String,
    required: true,
    trim: true
  },
  securityId: {
    type: String,
    required: true,
    trim: true
  },
  interval: {
    type: String,
    required: true,
    enum: ['1', '5', '15', '25', '60'], // Minutes
    trim: true
  },
  timestamp: {
    type: Date,
    required: true,
    index: true
  },
  open: {
    type: Number,
    required: true
  },
  high: {
    type: Number,
    required: true
  },
  low: {
    type: Number,
    required: true
  },
  close: {
    type: Number,
    required: true
  },
  volume: {
    type: Number,
    required: true,
    default: 0
  }
}, {
  timestamps: true // Adds createdAt and updatedAt
});

// Compound index to prevent duplicate candles
candleSchema.index({ securityId: 1, interval: 1, timestamp: 1 }, { unique: true });

// Index for faster queries
candleSchema.index({ stockName: 1, securityId: 1 });
candleSchema.index({ timestamp: -1 });

const Candle = mongoose.model('Candle', candleSchema);

module.exports = Candle;

