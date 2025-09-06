import express from "express";
import { Client, MessageMedia, LocalAuth, GroupChat } from "whatsapp-web.js";
import net, { Socket } from "node:net";
import ffmpeg from "fluent-ffmpeg";
import { exec } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import QRCode from "qrcode";
import * as utils from "./utils";
import { setUpChatGetters, setUpListGetters } from "./chat";

console.log("[FFmpeg] Using ffmpeg from: ", utils.ffmpegPath);
console.log("Using browser from: ", utils.SERVER_CONFIG.CHROME_PATH);

if (!fs.existsSync(utils.ffmpegPath))
  console.log("[Warning] FFmpeg does not exist!");

ffmpeg.setFfmpegPath(utils.ffmpegPath);

// Initialize Express app
const app = express();

// Middleware setup
app.use(express.json({ limit: "16mb" }));
app.use(express.urlencoded({ limit: "16mb", extended: true }));

let reInitializeCount = 1;

const client = new Client({
  puppeteer: {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--log-level=3",
      "--no-default-browser-check",
      "--disable-site-isolation-trials",
      "--no-experiments",
      "--ignore-gpu-blacklist",
      "--ignore-certificate-errors",
      "--ignore-certificate-errors-spki-list",
      "--enable-gpu",
      "--disable-default-apps",
      "--enable-features=NetworkService",
      "--disable-webgl",
      "--disable-threaded-animation",
      "--disable-threaded-scrolling",
      "--disable-in-process-stack-traces",
      "--disable-histogram-customizer",
      "--disable-gl-extensions",
      "--disable-composited-antialiasing",
      "--disable-canvas-aa",
      "--disable-3d-apis",
      "--disable-accelerated-2d-canvas",
      "--disable-accelerated-jpeg-decoding",
      "--disable-accelerated-mjpeg-decode",
      "--disable-app-list-dismiss-on-blur",
      "--disable-accelerated-video-decode",
      "--window-position=-200,-200",
      "--no-proxy-server",
      "--window-size=1,1",
    ],
    executablePath: utils.SERVER_CONFIG.CHROME_PATH,
  },
  authStrategy: new LocalAuth(),
});

const TOKENS = {
  SERVER: "3qGT_%78Dtr|&*7ufZoO",
  CLIENT: "vC.I)Xsfe(;p4YB6E5@y",
};

// Utility functions
function reconnect(socket: Socket) {
  console.log(`Attempting to reconnect with ${socket.address}`);
  setTimeout(() => {
    socket.connect(utils.SERVER_CONFIG.PORT, utils.SERVER_CONFIG.HOST, () => {
      console.log(`socket reconnected`);
    });
  }, 5000);
}

function setupWhatsAppEventListeners(socket: Socket) {
  client.setMaxListeners(16);

  client.on("message", async (message) => {
    if (message.broadcast === true) {
      socket.write(
        JSON.stringify({
          sender: "wspl-server",
          response: "NEW_BROADCAST_NOTI",
        }),
      );
    } else {
      socket.write(
        JSON.stringify({
          sender: "wspl-server",
          // NEW_MESSAGE
          response: "NEW_MESSAGE_NOTI",
          body: {
            msgBody: message.body,
            from: message.from.split("@")[0],
            author: message.author ? message.author.split("@")[0] : "",
            type: message.type,
          },
        }),
      );
    }
  });

  client.on("message_ack", async (message, ack) => {
    socket.write(
      JSON.stringify({
        sender: "wspl-server",
        response: "ACK_MESSAGE",
        body: {
          from: message.from.split("@")[0],
          msgId: message.id,
          ack: ack,
        },
      }),
    );
  });

  client.on("message_revoke_me", async (message) => {
    socket.write(
      JSON.stringify({
        sender: "wspl-server",
        response: "REVOKE_MESSAGE",
      }),
    );
  });

  client.on("message_revoke_everyone", async (message, revokedMessage) => {
    socket.write(
      JSON.stringify({
        sender: "wspl-server",
        response: "REVOKE_MESSAGE",
      }),
    );
  });

  client.on("group_join", async (notification) => {
    socket.write(
      JSON.stringify({
        sender: "wspl-server",
        response: "NEW_MESSAGE",
      }),
    );
  });

  client.on("group_update", async (notification) => {
    socket.write(
      JSON.stringify({
        sender: "wspl-server",
        response: "NEW_MESSAGE",
      }),
    );
  });

  client.on("chat_state_changed", ({ chatId, chatState }) => {
    socket.write(
      JSON.stringify({
        sender: "wspl-server",
        response: "CONTACT_CHANGE_STATE",
        body: {
          status: chatState,
          from: chatId.split("@")[0],
        },
      }),
    );
  });
}

global.loggedin = 0;
global.qrDataUrl = null;

// WhatsApp Client event listeners
client.on("qr", async (qr) => {
  try {
    console.log("Got a QR code");
    global.qrDataUrl = await QRCode.toDataURL(qr);
  } catch (err) {
    console.error("Failed to generate QR code data URL:", err);
  }
});

client.on("ready", () => {
  global.loggedin = 1;
  console.log("The server is ready.");
});

client.on("authenticated", () => {
  global.loggedin = 1;
  console.log("Authenticated");
});

client.on("disconnected", (reason) => {
  console.log("Disconnected");
  if (
    reInitializeCount === 1 &&
    reason !== "LOGOUT" /* &&
    reason !== WAState.DEPRECATED_VERSION */
  ) {
    reInitializeCount++;
    client.initialize();
  } else {
    global.loggedin = 0;
  }
});

client.on("remote_session_saved", () => {
  console.log("Session saved");
});

// HTTP Routes
app.get("/", async (_, res) => {
  res.send("WhatsApp Legacy for iOS 3.1 - 6.1.6");
});

app.get("/loggedInYet", (_, res) => {
  res.send(global.loggedin === 1 ? "true" : "false");
});

app.get("/qr", async (_, res) => {
  res.send(global.loggedin === 1 ? "Success" : global.qrDataUrl);
});

setUpListGetters(app, client);
setUpChatGetters(app, client);

app.post("/setTypingStatus/:contactId", async (req, res) => {
  try {
    const contactId = utils.buildContactId(
      req.params.contactId,
      req.query.isGroup === "1",
    );
    const chat = await client.getChatById(contactId);

    if (req.query.isVoiceNote === "1") {
      await chat.sendStateRecording();
    } else {
      await chat.sendStateTyping();
    }

    res.json({});
  } catch (error) {
    res.status(500).send(error.message);
  }
});

app.post("/clearState/:contactId", async (req, res) => {
  try {
    const contactId = utils.buildContactId(
      req.params.contactId,
      req.query.isGroup === "1",
    );
    const chat = await client.getChatById(contactId);
    await chat.clearState();
    res.status(200);
  } catch (error) {
    res.status(500).send(error.message);
  }
});

app.post("/seenBroadcast/:messageId", async (req, res) => {
  try {
    const messageId = decodeURIComponent(req.params.messageId);
    await client.getMessageById(messageId);
    res.status(200);
  } catch (error) {
    res.status(500).send(error.message);
  }
});

app.get("/getAudioData/:audioId", async (req, res) => {
  try {
    const audioId = decodeURIComponent(req.params.audioId);
    const message = await client.getMessageById(audioId);
    const media = await message.downloadMedia();

    if (media) {
      const audioBuffer = Buffer.from(media.data, "base64");
      await utils
        .downloadAndConvertAudio(audioBuffer)
        .catch((err) => res.status(500).json(err))
        .then((val) => {
          if (typeof val === "string") {
            res.set("Content-Type", "audio/mpeg");
            res.sendFile(val, (error) => {
              if (error) {
                console.error("Error sending file:", error);
                if (!res.headersSent) {
                  res.status(500).send("Error sending converted file.");
                }
              } else {
                fs.unlinkSync(val);
              }
            });
          }
        });
    } else {
      res.status(404).send("Audio not found");
    }
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).send(error.message);
    }
  }
});

app.get("/getDocument/:documentId", async (req, res) => {
  try {
    const documentId = decodeURIComponent(req.params.documentId);
    const message = await client.getMessageById(documentId);
    if (!message || !message.hasMedia) {
      return res.status(404).send("Message not found or it has no media.");
    }

    const media = await message.downloadMedia();
    if (media) {
      res.set("Content-Type", media.mimetype);
      // Include filename for the client
      res.set(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(media.filename)}`,
      );
      res.send(Buffer.from(media.data, "base64"));
    } else {
      res.status(404).send("Document not found.");
    }
  } catch (error) {
    console.error(`Error fetching document: ${error.message}`);
    if (!res.headersSent) {
      res.status(500).send(error.message);
    }
  }
});

app.get("/getMediaData/:mediaId", async (req, res) => {
  console.log("Downloading media from ID");
  try {
    const messageId = decodeURIComponent(req.params.mediaId);
    const message = await client.getMessageById(messageId);
    const media = await message.downloadMedia();

    if (!media) {
      console.log(`Failed to download media for message ID: ${messageId}`);
      return res.status(404).send("Media not found");
    }
    console.log(
      `Downloaded media for ID ${messageId}. Mimetype: ${media.mimetype}`,
    );

    const isVideo = media.mimetype.startsWith("video/");

    if (isVideo) {
      console.log("is mp4, starting conversion for iOS 3");
      const tempDir = os.tmpdir();

      const safeFilename = messageId.replace(/[^a-zA-Z0-9.-]/g, "_");
      const rawFile = path.join(tempDir, `${safeFilename}.mp4`);
      const movFile = path.join(tempDir, `${safeFilename}.mov`);

      fs.writeFileSync(rawFile, Buffer.from(media.data, "base64"));

      console.log("Converting video for iOS 3 standards");
      const cmd = `"${utils.ffmpegPath}" -y -i "${rawFile}" -vf "scale='min(640,iw)':'min(480,ih)':force_original_aspect_ratio=decrease,fps=30,yadif" -c:v libx264 -preset veryfast -crf 23 -c:a aac -b:a 160k -ar 48000 -ac 2 -movflags +faststart "${movFile}"`;

      const child = exec(cmd, (err) => {
        if (err) {
          console.error("FFmpeg error:", err);
          fs.unlink(rawFile, () => {});
          fs.unlink(movFile, () => {});
          return res.status(500).send("Failed to convert MP4 to MOV");
        }

        res.setHeader("Content-Type", "video/quicktime");
        const stream = fs.createReadStream(movFile);
        stream.pipe(res);

        stream.on("close", () => {
          fs.unlink(rawFile, () => {});
          fs.unlink(movFile, () => {});
        });
        stream.on("error", (streamErr) => {
          console.error("Stream error:", streamErr);
          fs.unlink(rawFile, () => {});
          fs.unlink(movFile, () => {});
          if (!res.headersSent) {
            res.status(500).end();
          }
        });
      });
      child.stdout &&
        child.stdout.on("data", (data) => console.log("ffmpeg stdout:", data));
      child.stderr &&
        child.stderr.on("data", (data) =>
          console.error("ffmpeg stderr:", data),
        );
    } else {
      // Send all other media types as-is
      res.setHeader("Content-Type", media.mimetype);
      res.send(Buffer.from(media.data, "base64"));
    }
  } catch (error) {
    console.error("Media error:", error);
    if (!res.headersSent) {
      res.status(500).send(error.message);
    }
  }
});

app.get("/getVideoThumbnail/:mediaId", async (req, res) => {
  try {
    const messageId = decodeURIComponent(req.params.mediaId);
    const message = await client.getMessageById(messageId);

    if (message && message.type === "video") {
      const media = await message.downloadMedia();

      if (media && media.mimetype.startsWith("video/")) {
        const videoBuffer = Buffer.from(media.data, "base64");
        const thumbnailPath = await utils.generateVideoThumbnail(videoBuffer);

        res.set("Content-Type", "image/png");
        res.sendFile(thumbnailPath, (error) => {
          if (error) {
            console.error("Error sending thumbnail:", error);
            if (!res.headersSent) {
              res.status(500).send("Error sending thumbnail file.");
            }
          } else {
            fs.unlinkSync(thumbnailPath);
          }
        });
      } else {
        res.status(404).send("Video not found.");
      }
    } else {
      res.status(404).send("Message not found or it is not a video.");
    }
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).send(error.message);
    }
  }
});

app.post("/sendMessage/:contactId", async (req, res) => {
  try {
    const isGroup = req.query.isGroup === "1";
    const contactId = utils.buildContactId(req.params.contactId, isGroup);
    const chat = await client.getChatById(contactId);

    // Send text message (optionally as reply)
    if (req.body.messageText) {
      if (req.body.replyTo) {
        const quoted = await client.getMessageById(req.body.replyTo);
        await quoted.reply(req.body.messageText);
      } else {
        await chat.sendMessage(req.body.messageText);
      }
    }

    // Send voice note
    if (req.body.sendAsVoiceNote) {
      const base64 = req.body.mediaBase64;
      const inputPath = path.join(os.tmpdir(), `temp_audio_${Date.now()}.caf`);
      const outputPath = path.join(
        os.tmpdir(),
        `temp_audio_out_${Date.now()}.mp3`,
      );
      fs.writeFileSync(inputPath, Buffer.from(base64, "base64"));

      ffmpeg(inputPath)
        .toFormat("mp3")
        .on("end", async () => {
          fs.unlinkSync(inputPath);
          const media = MessageMedia.fromFilePath(outputPath);
          await chat.sendMessage(media, { sendAudioAsVoice: true });
          fs.unlinkSync(outputPath);
        })
        .on("error", (err) => {
          console.error("Error during voice conversion:", err);
        })
        .save(outputPath);
    }

    // Send photo
    if (req.body.sendAsPhoto) {
      const base64 = req.body.mediaBase64;
      const imagePath = path.join(os.tmpdir(), `temp_img_${Date.now()}.jpg`);
      fs.writeFileSync(imagePath, Buffer.from(base64, "base64"));
      const media = MessageMedia.fromFilePath(imagePath);
      await chat.sendMessage(media);
      fs.unlinkSync(imagePath);
    }

    // Send Video
    /*
    base64 -i /Users/calvink/Desktop/video.mp4 | tr -d '\n' > tmp.b64

    jq -Rs --argjson sendAsVideo true '{sendAsVideo: $sendAsVideo, mediaBase64: .}' tmp.b64 > tmp.json

    curl -X POST http://localhost:7301/sendMessage/1xxxxxxxxxx \
      -H "Content-Type: application/json" \
      --data-binary @tmp.json
    */
    if (req.body.sendAsVideo) {
      const base64 = req.body.mediaBase64;
      const buffer = Buffer.from(base64, "base64");
      const videoPath = path.join(os.tmpdir(), `video_${Date.now()}.mp4`);
      fs.writeFileSync(videoPath, buffer);
      const media = MessageMedia.fromFilePath(videoPath);
      await chat.sendMessage(media);
      fs.unlinkSync(videoPath);
    }

    // Send sticker
    /*
    BASE64=$(base64 -i /Users/calvink/Desktop/sticker.png | tr -d '\n'

    curl -X POST http://localhost:7301/sendMessage/1xxxxxxxxxx \
     -H "Content-Type: application/json" \
     -d "{\"mediaBase64\":\"$BASE64\",\"sendAsSticker\":true}"
    */
    if (req.body.sendAsSticker) {
      const base64 = req.body.mediaBase64;
      const inputImagePath = path.join(
        os.tmpdir(),
        `sticker_input_${Date.now()}.png`,
      );
      const outputWebpPath = path.join(
        os.tmpdir(),
        `sticker_output_${Date.now()}.webp`,
      );
      fs.writeFileSync(inputImagePath, Buffer.from(base64, "base64"));

      await new Promise((resolve, reject) => {
        ffmpeg(inputImagePath)
          .outputOptions([
            "-vcodec",
            "libwebp",
            "-vf",
            "scale=512:512:force_original_aspect_ratio=decrease,fps=15",
            "-lossless",
            "1",
            "-preset",
            "default",
            "-loop",
            "0",
            "-an",
            "-vsync",
            "0",
          ])
          .toFormat("webp")
          .on("end", resolve)
          .on("error", reject)
          .save(outputWebpPath);
      });

      const stickerMedia = MessageMedia.fromFilePath(outputWebpPath);
      await chat.sendMessage(stickerMedia, { sendMediaAsSticker: true });

      fs.unlinkSync(inputImagePath);
      fs.unlinkSync(outputWebpPath);
    }

    res.status(200).json({ response: "ok" });
  } catch (err) {
    if (!res.headersSent) res.status(500).send(err.message);
  }
});

app.post("/setBlock/:contactId", async (req, res) => {
  try {
    const contactId = utils.buildContactId(
      req.params.contactId,
      req.query.isGroup === "1",
    );
    const contact = await client.getContactById(contactId);

    if (contact.isBlocked) {
      await contact.unblock();
    } else {
      await contact.block();
    }

    res.status(200).json({ response: "ok" });
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).send(error.message);
    }
  }
});

app.post("/readChat/:contactId", async (req, res) => {
  try {
    const isGroup = req.query.isGroup === "1";
    const rawId = req.params.contactId;
    const contactId = utils.buildContactId(rawId, isGroup);

    console.log("Contact:", rawId, "isGroup:", req.query.isGroup);
    console.log("Built ID:", contactId);

    const chat = await client.getChatById(contactId);
    console.log("Unread count:", chat.unreadCount);

    if (chat.unreadCount > 0) {
      await chat.sendSeen();
      console.log("Marked as seen!");
    } else {
      console.log("No unread messages.");
    }

    await client.resetState();

    res.status(200).json({ response: "ok" });
  } catch (error) {
    console.error("Error in readChat:", error);
    if (!res.headersSent) {
      res.status(500).send(error.message);
    }
  }
});

app.post("/leaveGroup/:groupId", async (req, res) => {
  try {
    const groupId = req.params.groupId + "@g.us";
    const chat = (await client.getChatById(groupId)) as GroupChat;
    await chat.leave();
    res.status(200).json({ response: "ok" });
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).send(error.message);
    }
  }
});

app.get("/getQuotedMessage/:messageId", async (req, res) => {
  try {
    const messageId = decodeURIComponent(req.params.messageId);
    const message = await client.getMessageById(messageId);

    if (!message) {
      return res.status(404).send("Message not found");
    }

    if (message.hasQuotedMsg) {
      const quotedMessage = await message.getQuotedMessage();
      return res.json({
        originalMessage: message.body,
        quotedMessage: {
          id: quotedMessage.id._serialized,
          body: quotedMessage.body,
          from: quotedMessage.from,
        },
      });
    }

    return res.status(404).send("No quoted message found");
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).send(error.message);
    }
  }
});

app.post("/setStatusInfo/:statusMsg", async (req, res) => {
  try {
    await client.setStatus(req.params.statusMsg);
    res.status(200).json({ response: "ok" });
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).send(error.message);
    }
  }
});

app.post("/deleteMessage/:messageId", async (req, res) => {
  try {
    const messageId = decodeURIComponent(req.params.messageId);
    const message = await client.getMessageById(messageId);

    if (!message) {
      return res.status(404).send("Message not found");
    }

    const deleteForEveryone = req.query.everyone === "1";
    await message.delete(deleteForEveryone);

    res.status(200);
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).send(error.message);
    }
  }
});

app.all("/logout", async (req, res) => {
  try {
    console.log("Logging out.");
    client.logout();
    res.status(200).send("Success");
  } catch (error) {
    res.status(500).send("Failed to logout: " + error.message);
  }
});

// Socket server setup
const socketServer = net.createServer((socket) => {
  socket.setEncoding("utf-8");

  // Send server token
  socket.write(
    JSON.stringify({
      sender: "wspl-server",
      token: TOKENS.SERVER,
    }),
  );

  // Set up WhatsApp client event listeners for this socket
  setupWhatsAppEventListeners(socket);

  // Handle socket data
  socket.on("data", (data) => {
    try {
      const parsedData = JSON.parse(data.toString("utf-8"));
      if (
        parsedData.sender === "wspl-client" &&
        parsedData.token === TOKENS.CLIENT
      ) {
        // clients.push(socket);
        socket.write(
          JSON.stringify({
            sender: "wspl-server",
            response: "ok",
          }),
        );
      } else {
        socket.write(
          JSON.stringify({
            sender: "wspl-server",
            response: "reject",
          }),
        );
        socket.destroy();
      }
    } catch (error) {
      console.error("Error parsing socket data:", error);
      socket.destroy();
    }
  });

  // Handle socket end
  socket.on("end", async () => {
    await client.destroy();
    socket.destroy();
    console.log("socket ended");
  });

  // Handle socket error
  socket.on("error", (error) => {
    console.error(error);
    console.log("reconnecting...");
    reconnect(socket);
  });
});

// Start servers
socketServer.listen(utils.SERVER_CONFIG.PORT, utils.SERVER_CONFIG.HOST);
client.initialize();
app.listen(utils.SERVER_CONFIG.HTTP_PORT);
