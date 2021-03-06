module.exports = function (RED) {
    const mbBasics = require('node-red-contrib-modbus/modbus/modbus-basics');

    function OpenPLC (config) {
        RED.nodes.createNode(this, config);

        this.name = config.name;
        this.program = config.program;
        this.programport = config.programport;
        this.rate = config.rate;
        this.rateUnit = config.rateUnit;
        this.digitaloutputs = config.digitaloutputs;
        this.analogoutputs = config.analogoutputs;
        this.digitaloutputoffset = config.digitaloutputoffset;
        this.analogoutputoffset = config.analogoutputoffset;

        const node = this;
        const modbusClient = RED.nodes.getNode(config.server);
        let timerID = null;
        let timeoutOccurred = false;

        setNodeStatusTo('waiting');

        node.onModbusInit = function () {
            setNodeStatusTo('initialize');
        };

        node.onModbusConnect = function () {
            clearInterval(timerID);
            timerID = setInterval(node.modbusPollingRead, mbBasics.calc_rateByUnit(node.rate, node.rateUnit));

            setNodeStatusTo('connected');
        };

        node.onModbusActive = function () {
            setNodeStatusTo('active');
        };

        node.onModbusError = function () {
            setNodeStatusTo('failure');
            clearInterval(timerID);

            timerID = null;
        };

        node.onModbusClose = function () {
            setNodeStatusTo('closed');
            clearInterval(timerID);

            timerID = null;
        };

        modbusClient.on('mbinit', node.onModbusInit);
        modbusClient.on('mbconnected', node.onModbusConnect);
        modbusClient.on('mbactive', node.onModbusActive);
        modbusClient.on('mberror', node.onModbusError);
        modbusClient.on('mbclosed', node.onModbusClose);

        node.on('input', function (msg) {
            if (!(msg && msg.hasOwnProperty('payload'))) return;
            if (!(msg.payload.register && msg.payload.register === "X" || msg.payload.register === "W")) return;

            if (!modbusClient.client) {
                return;
            }

            if (msg.payload.byte < 0 || msg.payload.byte > 99) return;
            if (msg.payload.bit < 0 || msg.payload.bit > 7) return;

            let fc;
            let address;

            if (msg.payload.register === "X") {
                fc = 5;
                address = msg.payload.byte * 8 + msg.payload.bit;
            } else {
                fc = 6;
                address = msg.payload.byte;
            }

            msg.payload = {
                value: msg.payload.value,
                unitid: 1,
                fc: fc,
                address: address,
                quantity: 1
            };

            modbusClient.emit('writeModbus', msg, function() {}, node.onModbusWriteError);
        });

        node.modbusPollingRead = function () {
            if (!modbusClient.client) {
                setNodeStatusTo('waiting');
                return;
            }

            if (node.digitaloutputs > 0) {
                // read coils
                let msgDigital = {
                    topic: 'polling',
                    from: node.name,
                    payload: {
                        unitid: 1,
                        fc: 1,
                        address: node.digitaloutputoffset,
                        quantity: node.digitaloutputs
                    }
                };
                modbusClient.emit('readModbus', msgDigital, node.onModbusReadDoneDigital, node.onModbusReadError);
            }

            if (node.analogoutputs > 0) {
                // read holding register
                let msgAnalog = {
                    topic: 'polling',
                    from: node.name,
                    payload: {
                        unitid: 1,
                        fc: 3,
                        address: node.analogoutputoffset,
                        quantity: node.analogoutputs
                    }
                };
                modbusClient.emit('readModbus', msgAnalog, node.onModbusReadDoneAnalog, node.onModbusReadError);
            }
        };

        node.onModbusReadDoneDigital = function (response) {
            const arr = response.data.map(function (x) {
                return { payload: x };
            });

            node.send(arr.slice(0, node.digitaloutputs));
        };

        node.onModbusReadDoneAnalog = function (response) {
            const arr = response.data.map(function (x) {
                return { payload: x };
            });

            // unshift null value for each digital output
            for (i = 0; i < node.digitaloutputs; i++) {
                arr.unshift(null);
            }

            node.send(arr);
        };

        node.onModbusReadError = function (err, msg) {
            setModbusError(err, msg);
        };

        node.onModbusWriteError = function (err, msg) {
            setModbusError(err, msg);
        };

        node.on('close', function () {
            clearInterval(timerID);

            timerID = null;
            setNodeStatusTo('closed');
        });

        function setNodeStatusTo (statusValue) {
            if (statusValue === 'polling' && timeoutOccurred) {
                return;
            }

            if (statusValue.search('active') !== -1 || statusValue === 'polling') {
                timeoutOccurred = false;
            }

            let statusOptions = mbBasics.set_node_status_properties(statusValue, false);
            node.status({
                fill: statusOptions.fill,
                shape: statusOptions.shape,
                text: statusOptions.status
            });
        }

        function setModbusError (err, msg) {
            let working = false;

            if (err) {
                switch (err.message) {
                    case 'Timed out':
                        timeoutOccurred = true;
                        setNodeStatusTo('timeout');
                        working = true;
                        break;
                    case 'FSM Not Ready To Read':
                        setNodeStatusTo('not ready to read');
                        working = true;
                        break;
                    case 'Port Not Open':
                        setNodeStatusTo('reconnect');
                        modbusClient.emit('reconnect');
                        working = true;
                        break;
                    default:
                        setNodeStatusTo('error: ' + JSON.stringify(err));
                }
            }
            return working;
        }

        // Upload program to the PLC using a multipart form request
        const request = require('request');
        let body = '------MNuE24x1ePo7oAAK\r\nContent-Disposition: form-data; name="file"; filename="duration"\r\nContent-Type: application/octet-stream\r\n\r\n';
        body += this.program;
        body += '\n\r\n------MNuE24x1ePo7oAAK\r\nContent-Disposition: form-data; name="submit"\r\n\r\nUpload Program\r\n------MNuE24x1ePo7oAAK--';

        request({
            url: "http://" + modbusClient.tcpHost + ":" + this.programport + "/api/upload",
            method: "POST",
            headers: {
                "content-type": "multipart/form-data; boundary=----MNuE24x1ePo7oAAK"
            },
            body: body
        }, function (error, response, body) {
            if (error) {
                node.status({fill: "red", shape: "ring", text: "program upload failed"});
                node.error("program upload failed");
            }
        });
    }

    RED.nodes.registerType("OpenPLC", OpenPLC);
};
