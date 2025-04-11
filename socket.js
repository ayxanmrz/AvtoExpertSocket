import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // Allow all origins (Change for security)
    methods: ["GET", "POST"],
  },
});

app.use(cors());

const API_URL = "http://192.168.52.120:4000/get-random-cars";

const lobbies = {}; // { lobbyId: { players, host, roundTime, totalRounds, currentRound, timer } }

function generateRoomId(length) {
  const characters =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let roomId = "";
  for (let i = 0; i < length; i++) {
    roomId += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return roomId;
}

// Create a lobby
io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on("create-lobby", ({ roundTime, totalRounds }) => {
    let lobbyId = generateRoomId(5);
    if (!lobbies[lobbyId]) {
      lobbies[lobbyId] = {
        players: [],
        host: socket.id,
        roundTime,
        totalRounds,
        cars: [],
        currentRound: 0,
        timer: null,
        lastScores: [],
        isLoading: false,
      };
      socket.join(lobbyId);
      io.to(lobbyId).emit("lobby-created", { lobbyId, host: socket.id });
    }
  });

  // Join a lobby
  socket.on("join-lobby", (lobbyId, username, callback) => {
    if (lobbies[lobbyId]) {
      if (lobbies[lobbyId].players.some((p) => p.username === username)) {
        callback({ status: false, err: "username_already_exists" });
        return;
      }

      lobbies[lobbyId].players.push({
        socketId: socket.id,
        username: username,
        score: 0,
      });
      socket.join(lobbyId);
      io.to(lobbyId).emit("player-joined", {
        players: lobbies[lobbyId].players,
      });
      let { roundTime, host, totalRounds, currentRound, isLoading } =
        lobbies[lobbyId];
      callback({
        status: true,
        lobby: { roundTime, host, totalRounds, currentRound, isLoading },
      });
    } else {
      callback({ status: false, err: "this_lobby_not_exist" });
    }
    console.log(lobbies);
  });

  socket.on("check-lobby", (lobbyId, callback) => {
    if (lobbies[lobbyId]) {
      callback({
        status: true,
      });
    } else {
      callback({ status: false });
    }
  });

  socket.on("lobby-param-change", (lobbyId, newParams, callback) => {
    if (lobbies[lobbyId]) {
      if (socket.id === lobbies[lobbyId].host) {
        lobbies[lobbyId] = { ...lobbies[lobbyId], ...newParams };
        io.to(lobbyId).emit("lobby-param-changed", { newParams });
        callback({ status: true });
      }
    } else {
      callback({ status: false });
    }
    console.log(lobbies);
  });

  socket.on("guess-price", (lobbyId, priceGuess, callback) => {
    if (lobbies[lobbyId]) {
      let lobby = lobbies[lobbyId];
      let score = calculateScore(
        lobby.cars[lobby.currentRound - 1].price,
        priceGuess
      );
      let playerLastScore = lobby.lastScores.find(
        (player) => player.socketId === socket.id
      );

      if (playerLastScore) {
        playerLastScore.score = score;
        playerLastScore.priceGuess = priceGuess;
      }

      lobby.players.find((player) => player.socketId === socket.id).score +=
        score;
      callback({ status: true, score });
    } else {
      callback({ status: false });
    }
    console.log(lobbies[lobbyId].players);
  });

  // Start game (Host only)
  // socket.on("start-game", (lobbyId) => {
  //   if (lobbies[lobbyId] && lobbies[lobbyId].host === socket.id) {
  //     lobbies[lobbyId].currentRound = 1;
  //     startRound(lobbyId);
  //   }
  // });

  socket.on("start-game", async (lobbyId) => {
    if (lobbies[lobbyId] && lobbies[lobbyId].host === socket.id) {
      io.to(lobbyId).emit("loading", { status: true }); // Notify client that loading starts
      lobbies[lobbyId].isLoading = true;
      const carsData = await fetchCars(lobbies[lobbyId].totalRounds); // Fetch car data

      if (carsData.error) {
        io.to(lobbyId).emit("game-error", { message: carsData.error });
        lobbies[lobbyId].isLoading = false;
      } else if (carsData.length === 0) {
        io.to(lobbyId).emit("game-error", { message: "Internal Server Error" });
        lobbies[lobbyId].isLoading = false;
      } else {
        io.to(lobbyId).emit("game-started", { roundNumber: carsData.length });
        lobbies[lobbyId].cars = carsData;
        lobbies[lobbyId].currentRound = 1;
        lobbies[lobbyId].isLoading = false;
        console.log(lobbies);
        startRound(lobbyId);
      }

      io.to(lobbyId).emit("loading", { status: false }); // Notify client that loading is done
    }
  });

  function startRound(lobbyId) {
    const lobby = lobbies[lobbyId];
    if (!lobby) return;

    lobby.lastScores = lobby.players.map((player) => ({
      username: player.username,
      socketId: player.socketId,
      priceGuess: 0,
      score: 0,
    }));

    io.to(lobbyId).emit("round-started", {
      round: lobby.currentRound,
      currentCar: lobby.cars[lobby.currentRound - 1],
      startTime: Date.now(),
    });

    lobby.timer = setTimeout(() => {
      endRound(lobbyId);
    }, lobby.roundTime * 1000);
  }

  function endRound(lobbyId) {
    const lobby = lobbies[lobbyId];
    if (!lobby) return;

    io.to(lobbyId).emit("round-ended", {
      round: lobby.currentRound,
      players: lobby.players,
      lastScores: lobby.lastScores,
      nextImage:
        lobby.currentRound !== lobby.cars.length
          ? lobby.cars[lobby.currentRound].images[0]
          : null,
    });

    if (lobby.currentRound < lobby.totalRounds) {
      lobby.currentRound++;
      setTimeout(() => startRound(lobbyId), 5000);
    } else {
      setTimeout(() => {
        io.to(lobbyId).emit("game-ended");
        lobby.currentRound = 0;
      }, 10000);
    }
  }

  const calculateScore = (actual, guess) => {
    let errorRatio = Math.abs(guess - actual) / actual;
    return Math.max(0, Math.round(1000 * (1 - errorRatio)));
  };

  const fetchCars = async (totalRounds) => {
    try {
      const response = await fetch(API_URL + "?number=" + totalRounds);
      if (!response.ok) throw new Error("Failed to fetch data");
      return await response.json();
    } catch (err) {
      console.error("Error fetching cars:", err.message);
      return { error: err.message };
    }
  };

  const playerLeft = (socketId) => {
    Object.keys(lobbies).forEach((lobbyId) => {
      const lobby = lobbies[lobbyId];
      lobby.players = lobby.players.filter(
        (player) => player.socketId !== socketId
      );

      if (lobby.players.length === 0) {
        clearTimeout(lobby.timer);
        delete lobbies[lobbyId];
      } else {
        lobby.host = lobby.players[0].socketId;
        io.to(lobbyId).emit("player-left", {
          players: lobby.players,
          host: lobby.host,
        });
      }
    });
  };

  socket.on("player-left", () => {
    playerLeft(socket.id);
  });

  // Handle player disconnection
  socket.on("disconnect", () => {
    playerLeft(socket.id);
  });
});

server.listen(8000, () => console.log("Server running on port 8000"));
