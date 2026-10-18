import mongoose from "mongoose";

/**
 * ONE place that decides how the app (server AND scripts) connects, so a script can never run against a
 * different database than the server (the URI's own default database is "test").
 */
export const mongoConnectOptions = (env = process.env) => ({
  dbName: env.DB_NAME || "attendance_tracker",
  // Fail fast instead of hanging for 30 s when the cluster is unreachable or the IP is not allow-listed.
  serverSelectionTimeoutMS: Number(env.MONGO_SERVER_SELECTION_TIMEOUT_MS) || 15000,
});

let listenersAttached = false;
const attachListeners = () => {
  if (listenersAttached) return;
  listenersAttached = true;
  mongoose.connection.on("disconnected", () => console.warn("⚠️  MongoDB disconnected (the driver will retry)"));
  mongoose.connection.on("reconnected", () => console.log("✅ MongoDB reconnected"));
  mongoose.connection.on("error", (e) => console.error(`❌ MongoDB error: ${e.message}`));
};

export const connectDB = async () => {
  try {
    if (!process.env.MONGO_URI) throw new Error("MONGO_URI is not set");
    attachListeners();
    const conn = await mongoose.connect(process.env.MONGO_URI, mongoConnectOptions());
    console.log(`✅ MongoDB connected: ${conn.connection.host} / ${conn.connection.name}`);
  } catch (error) {
    console.error(`❌ MongoDB connection failed: ${error.message}`);
    process.exit(1);
  }
};

/** For CLI scripts: same options as the server; throws instead of exiting so the script can report. */
export const connectForScript = async () => {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is not set");
  const conn = await mongoose.connect(process.env.MONGO_URI, mongoConnectOptions());
  console.log(`Connected to database "${conn.connection.name}" on ${conn.connection.host}`);
  return conn;
};
