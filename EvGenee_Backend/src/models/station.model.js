const mongoose = require('mongoose');

const stationSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },
  ownerofStation: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  location: {
    type: {
      type: String,
      enum: ["Point"],
      required: true,
    },
    coordinates: {
      type: [Number], 
      required: true,
    },
  },
  address: {
    city: { type: String, required: true },
    state: { type: String, required: true },
    country: { type: String, required: true },
    postalCode: { type: String, required: true },
    street: { type: String, required: true },
  },
  amenities: {
    type: [String],
    required: true,
  },
  totalPorts: {
    type: Number,
    required: true,
  },
  availablePorts: {
    type: Number,
    required: true,
  },
  chargingSpeed: {
    type: Number,
    required: true,
  },
  typeOfConnectors: {
    type: [String],
    required: true,
  },
  pricing: {
    type: [
      {
        priceperKWh: { type: Number, required: true },
        connectorType: { type: String, required: true },
        portCount: { type: Number, required: true, default: 1 },
        currency: {
          type: String,
          enum: ["USD", "EUR", "INR"],
          default: "INR",
        },
      },
    ],
    required: true,
  },
  peakPricing: {
    type: [
      {
        startTime: { type: String },
        endTime: { type: String },
        multiplier: { type: Number, default: 1.0 },
      }
    ],
    default: []
  },
  isOpen: {
    type: Boolean,
    default: true,
  },
  openingHours: {
    type: String,
    required: true,
  },
  contactInfo: {
    phoneNumber: { type: String, required: true },
    email: { type: String, required: true },
  },
  status: {
    type: String,
    enum: ["active", "inactive"],
    default: "active",
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  operator: {
    type: String,
    required: true,
  },
  Images: {
    type: [String],
    required: true,
  },
  reviews: [
    {
      userId: { type: String, required: true },
      comment: { type: String, required: true },
      rating: { type: Number, min: 0, max: 5, required: true },
    },
  ],
});

stationSchema.index({ location: "2dsphere" });

const Station = mongoose.model("Station", stationSchema);

module.exports = Station;