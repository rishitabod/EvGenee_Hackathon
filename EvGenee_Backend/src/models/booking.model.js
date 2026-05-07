const mongoose = require('mongoose');

const bookingSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    station: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Station',
      required: true,
    },
    connectorType: {
      type: String,
      enum: ['CCS2', 'CHAdeMO', 'Type2', 'Type1', 'Tesla'],
      required: true,
    },
    date: {
      type: Date,
      required: true,
    },
    startTime: {
      type: String, 
      required: true,
    },
    endTime: {
      type: String,
      required: true,
    },
    durationMinutes: {
      type: Number,
      required: true,
    },
    estimatedKWh: {
      type: Number,
      default: 0,
    },
    totalCost: {
      type: Number,
      required: true,
    },
    platformFee: {
      type: Number,
      default: 0,
    },
    grandTotal: {
      type: Number,
      required: true,
    },
    vehicleNumber: {
      type: String,
      default: '',
    },
    status: {
      type: String,
      enum: ['pending', 'confirmed', 'in-progress', 'completed', 'cancelled', 'no-show'],
      default: 'pending',
    },
    cancelledAt: {
      type: Date,
      default: null,
    },
    cancellationReason: {
      type: String,
      default: '',
    },
    checkedInAt: {
      type: Date,
      default: null,
    },
    completedAt: {
      type: Date,
      default: null,
    },
    otp: {
      type: String,
      select: false,
    },
    otpExpiresAt: {
      type: Date,
      select: false,
    },
    reminderSent: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

bookingSchema.index(
  { station: 1, date: 1, startTime: 1, connectorType: 1 },
  { unique: false }
);

bookingSchema.index({ user: 1, status: 1 });

bookingSchema.index({ station: 1, date: 1, connectorType: 1, status: 1, createdAt: 1 });

const Booking = mongoose.model('Booking', bookingSchema);

module.exports = Booking;