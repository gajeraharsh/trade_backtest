const mongoose = require('mongoose');

/**
 * DailySummary Schema for storing daily aggregated stock data
 * Prevents duplicates using compound index on securityId + date
 */
const dailySummarySchema = new mongoose.Schema({
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
  date: {
    type: Date,
    required: true,
    index: true
  },
  dailyHigh: {
    type: Number,
    required: true
  },
  dailyLow: {
    type: Number,
    required: true
  },
  open: {
    type: Number,
    required: true
  },
  close: {
    type: Number,
    required: true
  },
  totalVolume: {
    type: Number,
    required: true,
    default: 0
  }
}, {
  timestamps: true // Adds createdAt and updatedAt
});

// Compound index to prevent duplicate daily summaries
dailySummarySchema.index({ securityId: 1, date: 1 }, { unique: true });

// Index for faster queries
dailySummarySchema.index({ stockName: 1, securityId: 1 });
dailySummarySchema.index({ date: -1 });

const DailySummary = mongoose.model('DailySummary', dailySummarySchema);

module.exports = DailySummary;

