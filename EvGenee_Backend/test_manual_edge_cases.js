const mongoose = require('mongoose');
const User = require('./src/models/user.model');
const Station = require('./src/models/station.model');
const Booking = require('./src/models/booking.model');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const { MONGO_URI } = require('./src/config/config');

async function registerUser(email) {
  const user = {
    name: "Manual Test User",
    email: email,
    password: "Password123!",
    role: "user"
  };
  const res = await axios.post("http://localhost:5000/api/v1/users/register", user);
  return { token: res.data.token, userId: jwt.decode(res.data.token).id };
}

async function testManual() {
  await mongoose.connect(MONGO_URI);
  console.log("Connected to DB");

  const timestamp = Date.now();
  
  // 1. Create multiple Users
  console.log("Registering 4 test users...");
  const u1 = await registerUser(`user1_${timestamp}@test.com`);
  const u2 = await registerUser(`user2_${timestamp}@test.com`);
  const u3 = await registerUser(`user3_${timestamp}@test.com`);
  const u4 = await registerUser(`user4_${timestamp}@test.com`);

  // 2. Create a Station with specific port capacities
  const station = new Station({
    name: "Test Capacity Station",
    ownerofStation: u1.userId,
    location: { type: "Point", coordinates: [77.4126, 23.2599] },
    address: { city: "Bhopal", state: "MP", country: "India", postalCode: "462001", street: "Test Street" },
    amenities: ["WiFi"],
    totalPorts: 3,
    availablePorts: 3,
    chargingSpeed: 50,
    typeOfConnectors: ["CCS2", "Type2"],
    pricing: [
      { priceperKWh: 15, connectorType: "CCS2", portCount: 2, currency: "INR" }, 
      { priceperKWh: 10, connectorType: "Type2", portCount: 1, currency: "INR" } 
    ],
    openingHours: "00:00-23:59",
    contactInfo: { phoneNumber: "1234567890", email: "station@test.com" },
    operator: "Test Operator",
    Images: ["http://image.url"]
  });
  await station.save();

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dateStr = tomorrow.toISOString().split('T')[0];

  const api = (token) => axios.create({
    baseURL: 'http://localhost:5000/api/v1',
    headers: { Authorization: `Bearer ${token}` },
    validateStatus: () => true 
  });

  console.log("\n--- TEST 1: Check Availability for CCS2 (Capacity 2) ---");
  const availRes = await api(u1.token).get(`/bookings/availability?stationId=${station._id}&date=${dateStr}&connectorType=CCS2`);
  if (availRes.data.success) {
    console.log(`✅ Slot 10:00-10:30 Total Ports for CCS2: ${availRes.data.data.slots.find(s => s.startTime === "10:00").totalPorts}`);
  }

  console.log("\n--- TEST 2: Book CCS2 up to capacity (2 ports) with different users ---");
  const b1 = await api(u1.token).post(`/bookings/create`, {
    station: station._id,
    connectorType: "CCS2",
    date: dateStr,
    startTime: "10:00",
    endTime: "11:00"
  });
  console.log("User 1 Booking (CCS2):", b1.status, b1.data.message || b1.data.error);

  const b2 = await api(u2.token).post(`/bookings/create`, {
    station: station._id,
    connectorType: "CCS2",
    date: dateStr,
    startTime: "10:00",
    endTime: "11:00"
  });
  console.log("User 2 Booking (CCS2):", b2.status, b2.data.message || b2.data.error);

  console.log("\n--- TEST 3: Book CCS2 exceeding capacity (Should Fail - 3rd booking for CCS2) ---");
  const b3 = await api(u3.token).post(`/bookings/create`, {
    station: station._id,
    connectorType: "CCS2",
    date: dateStr,
    startTime: "10:00",
    endTime: "11:00"
  });
  console.log("User 3 Booking (CCS2) Result:", b3.status, b3.data.message || b3.data.error);

  console.log("\n--- TEST 4: Book Type2 (1 port) while CCS2 is full (Should Pass) ---");
  const b4 = await api(u4.token).post(`/bookings/create`, {
    station: station._id,
    connectorType: "Type2",
    date: dateStr,
    startTime: "10:00",
    endTime: "11:00"
  });
  console.log("User 4 Booking (Type2) Result:", b4.status, b4.data.message || b4.data.error);

  // Clean up
  console.log("\nCleaning up...");
  await Booking.deleteMany({ station: station._id });
  await Station.findByIdAndDelete(station._id);
  await User.deleteMany({ email: { $regex: timestamp.toString() } });

  mongoose.connection.close();
}

testManual().catch(console.error);
