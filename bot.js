var net = require("net");
var bson = require("bson");
var dns = require("dns");
var lzma = require("lzma-native");

const SERVER_PORT = 10001;

function decodeJson(data) {
    return bson.deserialize(data.slice(4));
}

function encodeJson(json) {
    const data = bson.serialize(json);
    var buf = Buffer.alloc(4 + data.byteLength);
    buf.writeInt32LE(4 + data.byteLength);
    data.copy(buf, 4);
    return buf;
}

function getTimeStamp() {
    return ((Date.now() * 10000) + 621355968000000000);
}

class Tile {
    constructor(foreID, backID) {
        this.foreID = foreID;
        this.backID = backID;
    }
}

class World {
    deserialize = (data) => {
        const json = bson.deserialize(data);

        this.loadedAt = Date.now();

        this.sizeX = json["WorldSizeSettingsType"]["WorldSizeX"];
        this.sizeY = json["WorldSizeSettingsType"]["WorldSizeY"];

        this.mainDoorX = json["WorldStartPoint"]["x"];
        this.mainDoorY = json["WorldStartPoint"]["y"];

        this.tiles = [];

        var fgLayer = json["BlockLayer"].buffer;
        var bgLayer = json["BackgroundLayer"].buffer;
        for (var y = 0; y < this.sizeY; ++y) {
            for (var x = 0; x < this.sizeX; ++x) {
                var index = x + y * this.sizeX;
                var fgLayerCur = fgLayer.slice(index * 2, index * 2 + 2);
                var bgLayerCur = bgLayer.slice(index * 2, index * 2 + 2);

                var foreID = fgLayerCur.readInt16LE();
                var backID = bgLayerCur.readInt16LE();
                this.tiles.push(new Tile(foreID, backID));
            }
        }
    }
}

class Bot {
    constructor() {
        this.receivedData = [];
        this.dataLength = 0;

        this.packetQueue = [];

        this.syncTimeInterval = null;

        this.world = null;
        this.spawned = false;

        this.x = 0.0;
        this.y = 0.0;
    }

    setLogin(coID, token) {
        this.coID = coID;
        this.token = token;
    }

    setWorldDest(world) {
        this.worldDest = world;
    }

    connect(ip) {
        if (this.client) {
            this.client.destroy();
            this.world = null;
            this.spawned = false;
        }

        this.client = new net.Socket();
        this.client.connect(SERVER_PORT, ip, this.onConnect);
        this.client.on("data", this.onReceive);
        this.client.on("close", this.onDisconnect);
    }

    onConnect = () => {
        console.log("Connected");
        this.sendLogin();
        this.sendAll();

        this.pushPacket({ "ID": "gLSI" });

        this.syncTimeInterval = setInterval(() => {
            this.syncTime();
        }, 2000);
    }

    onReceive = (data) => {
        // receive full data
        if (this.dataLength == 0) {
            var dataLength = data.readInt32LE();
            if (data.length != dataLength) {
                this.receivedData.push(data);
                this.dataLength = dataLength
                return;
            }
            else {
                this.receivedData = data;
            }
        }
        else {
            this.receivedData.push(data);
            if (Buffer.concat(this.receivedData).length != this.dataLength) {
                return; // wait for more data
            }
        }

        var buf = null;
        if (this.dataLength == 0) {
            buf = Buffer.from(this.receivedData);
        }
        else {
            buf = Buffer.concat(this.receivedData);
        }
        
        var json = decodeJson(buf);

        var packetCount = json["mc"];
        for (var i = 0; i < packetCount; ++i) {
            this.processPacket(json[`m${i}`]);
        }

        this.sendAll();
        this.receivedData = [];
        this.dataLength = 0;
    }

    onDisconnect = () => {
        console.log("Disconnected");
        clearInterval(this.syncTimeInterval);
    }

    processPacket(json) {
        console.log(json);

        if (this.onWorld() && !this.spawned) {
            var x = this.world.mainDoorX / 3.2;
            var y = this.world.mainDoorY / 3.2;
            this.sendMove(x, y);
            this.spawned = true;
        }

        var id = json["ID"];
        switch (id) {
            case "VChk":
                console.log("Logging in");
                this.sendGpd();
                break;
            case "GPd":
                this.joinWorld(this.worldDest);
                break;
            case "TTjW":
                this.sendGetWorld(json["WN"]);
                break;
            case "OoIP":
                dns.lookup(json["IP"], this.onRedirect);
                break;
            case "GWC":
                this.world = new World();
                lzma.decompress(json["W"].buffer, this.world.deserialize);

                this.sendSpawn();
                break;
            case "WCM":
                // chat message
                var text = json["CmB"]["message"];
                var userID = json["CmB"]["userID"];
                console.log("%s said: %s", userID, text);
                break;
        }
    }

    onWorld() {
        if (!this.world) {
            return false;
        }
        return Date.now() - this.world.loadedAt >= 2000;
    }

    onRedirect = (err, ip) => {
        console.log("Redirecting to: %s", ip);
        this.connect(ip);
    }

    sendLogin() {
        this.pushPacket({ "ID": "VChk", "OS": "WindowsPlayer", "OSt": 3 });
    }

    sendGpd() {
        this.pushPacket({ "ID": "GPd", "CoID": this.coID, "Tk": this.token, "cgy": 877 });
    }

    joinWorld(name) {
        this.pushPacket({ "ID": "TTjW", "W": name, "Amt": 0 });
    }

    sendGetWorld(name) {
        this.pushPacket({ "ID": "Gw", "eID": "", "W": name });
    }

    syncTime() {
        this.pushPacket({ "ID": "ST", "STime": getTimeStamp() });
    }

    sendSpawn() {
        this.pushPacket({ "ID": "RtP" });
    }

    sendMove(x, y, a = 1, d = 7) {
        var newX = Math.floor(x * Math.PI);
        var newY = Math.floor(y * Math.PI);
        if (this.x != newX || this.y != newY) {
            var buf = Buffer.alloc(8);
            buf.writeInt32LE(newX);
            buf.writeInt32LE(newY, 4);
            this.pushPacket({ "ID": "mp", "pM": buf });
        }

        this.pushPacket({ "ID": "mP", "t": getTimeStamp(), "x": x, "y": y, "a": a, "d": d });

        this.x = x;
        this.y = y;
    }

    pushPacket(json) {
        this.packetQueue.push(json);
    }

    sendAll() {
        var json = {};

        this.packetQueue.forEach((item, index) => {
            json[`m${index}`] = item;
        });

        json["mc"] = this.packetQueue.length;

        this.client.write(encodeJson(json));
        this.packetQueue = [];
    }
}

var bot = new Bot();

// both 'coID' and 'token' can be obtained from WireShark or any other tool to capture packets
// if using empty or random string, the account will end up being new
bot.setLogin(
    "",
    ""
);

bot.setWorldDest("buy"); // bot will enter world 'buy' after connection

bot.connect("44.194.163.69");
