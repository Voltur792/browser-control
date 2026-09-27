using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

internal static class Program
{
    private const string ExtensionId = "gfnmcopdoaehakblkhonjloehlhfjgod";
    private const string HostName = "com.voltur.browser_control";
    private const int BridgePort = 48317;
    private static readonly object OutputLock = new();
    private static readonly object SocketWriteLock = new();
    private static readonly ManualResetEventSlim Ready = new(false);
    private static volatile bool Authenticated;
    private static Stream? NativeOutput;
    private static StreamWriter? BridgeWriter;
    private static int Main(string[] args)
    {
        NativeOutput = Console.OpenStandardOutput();
        if (args.Length == 0 || args[0] != $"chrome-extension://{ExtensionId}/")
        {
            Log("Rejected native messaging origin.");
            return 2;
        }

        try
        {
            using var tcp = ConnectToPlugin();
            var stream = tcp.GetStream();
            using var reader = new StreamReader(stream, new UTF8Encoding(false), false, 4096, true);
            BridgeWriter = new StreamWriter(stream, new UTF8Encoding(false), 4096, true) { AutoFlush = true, NewLine = "\n" };
            var secretPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "BrowserControl", "bridge-secret.txt");
            var secret = File.ReadAllText(secretPath, Encoding.UTF8).Trim();
            var clientNonce = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
            SendToBridge(new JsonObject { ["type"] = "hello", ["nonce"] = clientNonce });

            var socketReader = new Thread(() => ReadBridgeMessages(reader, secret, clientNonce)) { IsBackground = true, Name = "browser-control-native-reader" };
            socketReader.Start();
            if (!Ready.Wait(TimeSpan.FromSeconds(5)) || !Authenticated)
            {
                SendFrame(new JsonObject { ["type"] = "native_error", ["error"] = "Плагин Astra не подтвердил подключение" });
                return 3;
            }

            using var input = Console.OpenStandardInput();
            while (true)
            {
                var message = ReadFrame(input);
                if (message is null) break;
                SendToBridge(message);
            }
            return 0;
        }
        catch (Exception ex)
        {
            Log(ex.Message);
            try { SendFrame(new JsonObject { ["type"] = "native_error", ["error"] = "Плагин Astra не запущен или локальный мост недоступен" }); }
            catch { }
            return 1;
        }
    }

    private static TcpClient ConnectToPlugin()
    {
        var deadline = DateTime.UtcNow.AddSeconds(4);
        Exception? last = null;
        while (DateTime.UtcNow < deadline)
        {
            try
            {
                var client = new TcpClient(AddressFamily.InterNetwork);
                var attempt = client.ConnectAsync("127.0.0.1", BridgePort);
                if (!attempt.Wait(TimeSpan.FromMilliseconds(600))) { client.Dispose(); throw new TimeoutException("Локальный мост отвечает слишком долго"); }
                if (attempt.IsFaulted) { client.Dispose(); throw attempt.Exception?.GetBaseException() ?? new IOException("Не удалось подключиться"); }
                client.NoDelay = true;
                return client;
            }
            catch (Exception ex)
            {
                last = ex;
                Thread.Sleep(300);
            }
        }
        throw new IOException("Плагин Astra не запущен", last);
    }

    private static string Proof(string secret, string role, string clientNonce, string serverNonce)
    {
        var key = Encoding.UTF8.GetBytes(secret);
        var payload = Encoding.ASCII.GetBytes($"browser-control-v2:{role}:{clientNonce}:{serverNonce}");
        return Convert.ToHexString(HMACSHA256.HashData(key, payload)).ToLowerInvariant();
    }

    private static bool ProofMatches(string actual, string expected)
    {
        try
        {
            return actual.Length == 64 && CryptographicOperations.FixedTimeEquals(
                Convert.FromHexString(actual), Convert.FromHexString(expected));
        }
        catch (FormatException) { return false; }
    }

    private static void ReadBridgeMessages(StreamReader reader, string secret, string clientNonce)
    {
        var challenged = false;
        try
        {
            while (reader.ReadLine() is { } line)
            {
                var message = JsonNode.Parse(line);
                if (message is not JsonObject obj) throw new InvalidDataException("Invalid bridge response");
                if (!challenged)
                {
                    if (obj["type"]?.GetValue<string>() != "hello_challenge") throw new InvalidDataException("Bridge challenge missing");
                    var serverNonce = obj["nonce"]?.GetValue<string>() ?? "";
                    var proof = obj["proof"]?.GetValue<string>() ?? "";
                    if (serverNonce.Length != 64 || !serverNonce.All(Uri.IsHexDigit) ||
                        !ProofMatches(proof, Proof(secret, "server", clientNonce, serverNonce)))
                        throw new InvalidDataException("Bridge authentication failed");
                    SendToBridge(new JsonObject { ["type"] = "hello_auth", ["proof"] = Proof(secret, "host", clientNonce, serverNonce) });
                    challenged = true;
                }
                else if (!Authenticated)
                {
                    if (obj["type"]?.GetValue<string>() != "hello_ack" || obj["ok"]?.GetValue<bool>() != true ||
                        obj["protocol"]?.GetValue<int>() != 2)
                        throw new InvalidDataException("Bridge acknowledgement failed");
                    Authenticated = true;
                    Ready.Set();
                    SendFrame(new JsonObject { ["type"] = "native_ready", ["ok"] = true });
                }
                else if (obj["type"]?.GetValue<string>() == "command")
                {
                    SendFrame(obj);
                }
            }
        }
        catch (Exception ex) { Log(ex.Message); }
        finally
        {
            Ready.Set();
            try { SendFrame(new JsonObject { ["type"] = "native_error", ["error"] = "Локальная связь с Astra прервана" }); }
            catch { }
        }
    }

    private static void SendToBridge(JsonNode message)
    {
        lock (SocketWriteLock)
        {
            if (BridgeWriter is null) throw new IOException("Локальный мост не готов");
            BridgeWriter.WriteLine(message.ToJsonString());
        }
    }

    private static JsonNode? ReadFrame(Stream input)
    {
        var lengthBytes = ReadExactly(input, 4);
        if (lengthBytes is null) return null;
        var length = BinaryPrimitives.ReadInt32LittleEndian(lengthBytes);
        if (length <= 0 || length > 64 * 1024 * 1024) throw new InvalidDataException("Invalid native message length");
        var bytes = ReadExactly(input, length) ?? throw new EndOfStreamException();
        return JsonNode.Parse(bytes);
    }

    private static byte[]? ReadExactly(Stream input, int length)
    {
        var buffer = new byte[length];
        var offset = 0;
        while (offset < length)
        {
            var read = input.Read(buffer, offset, length - offset);
            if (read == 0) return offset == 0 ? null : throw new EndOfStreamException();
            offset += read;
        }
        return buffer;
    }

    private static void SendFrame(JsonNode message)
    {
        var bytes = Encoding.UTF8.GetBytes(message.ToJsonString());
        Span<byte> length = stackalloc byte[4];
        BinaryPrimitives.WriteInt32LittleEndian(length, bytes.Length);
        lock (OutputLock)
        {
            NativeOutput!.Write(length);
            NativeOutput.Write(bytes);
            NativeOutput.Flush();
        }
    }

    private static void Log(string message)
    {
        try
        {
            var directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "BrowserControl");
            Directory.CreateDirectory(directory);
            File.AppendAllText(Path.Combine(directory, "native-host.log"), $"{DateTimeOffset.Now:O} {message}{Environment.NewLine}", Encoding.UTF8);
        }
        catch { }
    }
}
