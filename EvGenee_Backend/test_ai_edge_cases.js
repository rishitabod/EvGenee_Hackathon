const io = require("socket.io-client");
const axios = require("axios");

const queries = [
  // Edge Case 1: Out of Topic
  "What is the capital of France?",
  
  // Edge Case 2: Past Date
  "I want to book a CCS2 charger near Bhopal for yesterday at 10:00 AM.",
  
  // Edge Case 3: Valid Future Date
  "I want to book a CCS2 charger near Bhopal for tomorrow at 10:00 AM to 12:00 PM."
];

async function testAgent() {
  console.log("1. Registering a test user to get a token...");
  const timestamp = Date.now();
  const user = {
    name: "Test User",
    email: `testuser_${timestamp}@example.com`,
    password: "Password123!",
    role: "user"
  };

  try {
    const res = await axios.post("http://localhost:5000/api/v1/users/register", user);
    const token = res.data.token;
    console.log("=> Token acquired!");

    const socket = io("http://localhost:5000", {
      auth: { token }
    });

    socket.on("connect", async () => {
      console.log("=> Socket connected!\n");
      
      for (let i = 0; i < queries.length; i++) {
        console.log(`\n--- Test Case ${i + 1} ---`);
        console.log(`Query: "${queries[i]}"`);
        
        await new Promise((resolve) => {
          socket.emit("ai:voice_chat", {
            message: queries[i],
            threadId: `test-thread-${timestamp}-${i}`
          });
          
          socket.once("ai:voice_response", (data) => {
            console.log("\n====== AI RESPONSE ======");
            console.log(data.response);
            if (data.stations) console.log("Stations returned:", data.stations.length);
            console.log("=========================\n");
            resolve();
          });
        });
      }
      
      socket.disconnect();
      process.exit(0);
    });

    socket.on("connect_error", (err) => {
      console.error("Socket Connection Error:", err.message);
      process.exit(1);
    });

  } catch (error) {
    console.error("Error:", error.response ? error.response.data : error.message);
    process.exit(1);
  }
}

testAgent();
