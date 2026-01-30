import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_ORIGIN,
    methods: ["GET", "POST"],
  },
});

app.use(cors({ origin: process.env.CLIENT_ORIGIN }));

const API_URL = process.env.SERVER_API;

const lobbies = {}; // { lobbyId: { players, host, roundTime, totalRounds, currentRound, timer } }

function generateRoomId(length) {
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let roomId = "";
  for (let i = 0; i < length; i++) {
    roomId += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return roomId;
}

io.on("connection", (socket) => {
  const rawIp =
    socket.handshake.headers["x-forwarded-for"]?.split(",")[0].trim() ||
    socket.handshake.address ||
    socket.request?.connection?.remoteAddress;
  socket.data.ip = normalizeIp(rawIp);
  console.log(`User connected: ${socket.id} from IP: ${socket.data.ip}`);

  socket.on("get-server-time", (callback) => {
    callback(Date.now());
  });

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
        // The bannedPlayers set now stores persistent client IDs
        bannedPlayers: new Set(),
        isLoading: false,
        isDirty: false,
      };
      socket.join(lobbyId);
      io.to(lobbyId).emit("lobby-created", { lobbyId, host: socket.id });
    }
  });

  socket.on("join-lobby", (lobbyId, username, clientId, callback) => {
    if (lobbies[lobbyId]) {
      const isBanned = lobbies[lobbyId].bannedPlayers.has(clientId);
      if (isBanned) {
        callback({ status: false, err: "banned_from_lobby" });
        return;
      }

      if (lobbies[lobbyId].players.some((p) => p.username === username)) {
        callback({ status: false, err: "username_already_exists" });
        return;
      }

      const newClientId = clientId || uuidv4();

      lobbies[lobbyId].players.push({
        socketId: socket.id,
        username: username,
        clientId: newClientId,
        score: 0,
      });
      socket.data.clientId = newClientId;
      socket.join(lobbyId);
      io.to(lobbyId).emit("player-joined", {
        players: lobbies[lobbyId].players,
      });
      let { roundTime, host, totalRounds, currentRound, isLoading, isDirty } =
        lobbies[lobbyId];
      callback({
        status: true,
        lobby: {
          roundTime,
          host,
          totalRounds,
          currentRound,
          isLoading,
          isDirty,
        },
        clientId: newClientId,
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
        priceGuess,
      );
      let playerLastScore = lobby.lastScores.find(
        (player) => player.socketId === socket.id,
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

  socket.on("start-game", async (lobbyId, { totalRounds, roundTime }) => {
    const lobby = lobbies[lobbyId];
    if (!lobby || lobby.host !== socket.id) return;

    io.to(lobbyId).emit("loading", { status: true });
    lobby.isLoading = true;
    lobby.totalRounds = totalRounds;
    lobby.roundTime = roundTime;
    lobby.isDirty = true;

    try {
      const carsData = await fetchCars(lobby.totalRounds);

      if (carsData.error) {
        io.to(lobbyId).emit("game-error", { message: carsData.error });
        lobby.isLoading = false;
        return;
      }

      if (!carsData.cars?.length) {
        io.to(lobbyId).emit("game-error", { message: "Internal Server Error" });
        lobby.isLoading = false;
        return;
      }

      lobby.cars = carsData.cars;
      lobby.currentRound = 1;
      lobby.isLoading = false;

      io.to(lobbyId).emit("game-started", {
        roundNumber: lobby.cars.length,
      });

      startRound(lobbyId);
    } finally {
      io.to(lobbyId).emit("loading", { status: false });
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

    const { price, ...carWithOutPrice } = lobby.cars[lobby.currentRound - 1];

    io.to(lobbyId).emit("round-started", {
      round: lobby.currentRound,
      currentCar: carWithOutPrice,
      endTime: Date.now() + lobby.roundTime * 1000,
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
      lastPrice: lobby.cars[lobby.currentRound - 1].price,
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
        (player) => player.socketId !== socketId,
      );

      if (lobby.players.length === 0) {
        clearTimeout(lobby.timer);
        delete lobbies[lobbyId];
      } else {
        // Reassign host if the host leaves
        if (lobby.host === socketId) {
          lobby.host = lobby.players[0].socketId;
          io.to(lobbyId).emit("host-changed", { newHost: lobby.host });
        }
        io.to(lobbyId).emit("player-left", {
          players: lobby.players,
          host: lobby.host,
        });
      }
    });
  };

  function normalizeIp(ip) {
    if (!ip) return ip;
    return ip.startsWith("::ffff:") ? ip.replace("::ffff:", "") : ip;
  }

  // Banning logic uses clientId
  socket.on("ban-player", (lobbyId, playerSocketId, cb) => {
    const lobby = lobbies[lobbyId];
    if (!lobby) return cb?.({ status: false, err: "this_lobby_not_exist" });
    if (socket.id !== lobby.host)
      return cb?.({ status: false, err: "only_host_can_ban" });

    // Find the client ID of the player to be banned
    const playerToBan = lobby.players.find(
      (p) => p.socketId === playerSocketId,
    );
    if (!playerToBan) {
      return cb?.({ status: false, err: "player_not_found" });
    }

    // Add the client ID to the banned set
    lobby.bannedPlayers.add(playerToBan.clientId);
    console.log(
      `Banning clientId: ${playerToBan.clientId} in lobby: ${lobbyId}`,
    );

    // Find and disconnect the banned player
    const targetSocket = io.sockets.sockets.get(playerSocketId);
    if (targetSocket) {
      targetSocket.leave(lobbyId);
      targetSocket.emit("you-are-banned", { lobbyId });
      playerLeft(targetSocket.id);
    }

    cb?.({ status: true });
  });

  socket.on("make-host", (lobbyId, newHostSocketId, callback) => {
    const lobby = lobbies[lobbyId];
    if (!lobby)
      return callback?.({ status: false, err: "this_lobby_not_exist" });
    if (socket.id !== lobby.host)
      return callback?.({ status: false, err: "only_host_can_ban" });

    const targetSocket = io.sockets.sockets.get(newHostSocketId);
    if (!targetSocket)
      return callback?.({ status: false, err: "player_not_found" });

    if (!lobby.players.some((p) => p.socketId === newHostSocketId))
      return callback?.({ status: false, err: "player_not_in_lobby" });

    lobby.host = newHostSocketId;
    io.to(lobbyId).emit("host-changed", { newHost: newHostSocketId });
    callback?.({ status: true });
  });

  socket.on("reset-points", (lobbyId, callback) => {
    const lobby = lobbies[lobbyId];
    if (!lobby) return callback?.({ status: false });
    if (socket.id !== lobby.host) return callback?.({ status: false });

    lobby.players.forEach((player) => {
      player.score = 0;
    });
    lobby.isDirty = false;
    io.to(lobbyId).emit("points-reset", {
      players: lobby.players,
    });
    callback?.({ status: true });
  });

  socket.on("player-left", () => {
    playerLeft(socket.id);
  });

  socket.on("disconnect", () => {
    playerLeft(socket.id);
  });
});

server.listen(process.env.PORT || 8000, () =>
  console.log("Server running on port 8000"),
);
