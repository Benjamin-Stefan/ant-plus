import EventEmitter from "events";
import { USBDriver } from "../core/USBDriver.js";
import { SendCallback } from "../types/SendCallback.js";
import { Constants } from "../types/constants.js";
import { Messages } from "../utils/messages.js";

export abstract class BaseSensor extends EventEmitter {
    channel: number;
    deviceID: number;
    transmissionType: number;

    private msgQueue: { msg: Buffer; cbk?: SendCallback }[] = [];

    protected decodeDataCbk: (data: Buffer) => void;
    protected statusCbk: (status: { msg: number; code: number }) => boolean;

    protected abstract updateState(deviceId: number, data: Buffer): void;

    constructor(private stick: USBDriver) {
        super();
        stick.on("read", this.handleEventMessages.bind(this));
    }

    protected scan(type: string, frequency: number) {
        if (this.channel !== undefined) {
            throw "already attached";
        }

        if (!this.stick.canScan) {
            throw "stick cannot scan";
        }

        const channel = 0;

        const onStatus = status => {
            switch (status.msg) {
                case Constants.MESSAGE_RF:
                    switch (status.code) {
                        case Constants.EVENT_CHANNEL_CLOSED:
                        case Constants.EVENT_RX_FAIL_GO_TO_SEARCH:
                            this.write(Messages.unassignChannel(channel));
                            return true;
                        case Constants.EVENT_TRANSFER_TX_COMPLETED:
                        case Constants.EVENT_TRANSFER_TX_FAILED:
                        case Constants.EVENT_RX_FAIL:
                        case Constants.INVALID_SCAN_TX_CHANNEL:
                            const mc = this.msgQueue.shift();
                            if (mc && mc.cbk) {
                                mc.cbk(status.code === Constants.EVENT_TRANSFER_TX_COMPLETED);
                            }
                            if (this.msgQueue.length) {
                                this.write(this.msgQueue[0].msg);
                            }
                            return true;
                        default:
                            break;
                    }
                    break;
                case Constants.MESSAGE_CHANNEL_ASSIGN:
                    this.write(Messages.setDevice(channel, 0, 0, 0));
                    return true;
                case Constants.MESSAGE_CHANNEL_ID:
                    this.write(Messages.setFrequency(channel, frequency));
                    return true;
                case Constants.MESSAGE_CHANNEL_FREQUENCY:
                    this.write(Messages.setRxExt());
                    return true;
                case Constants.MESSAGE_ENABLE_RX_EXT:
                    this.write(Messages.libConfig(channel, 0xe0));
                    return true;
                case Constants.MESSAGE_LIB_CONFIG:
                    this.write(Messages.openRxScan());
                    return true;
                case Constants.MESSAGE_CHANNEL_OPEN_RX_SCAN:
                    process.nextTick(() => this.emit("attached"));
                    return true;
                case Constants.MESSAGE_CHANNEL_CLOSE:
                    return true;
                case Constants.MESSAGE_CHANNEL_UNASSIGN:
                    this.statusCbk = undefined;
                    this.channel = undefined;
                    process.nextTick(() => this.emit("detached"));
                    return true;
                case Constants.MESSAGE_CHANNEL_ACKNOWLEDGED_DATA:
                    return status.code === Constants.TRANSFER_IN_PROGRESS;
                default:
                    break;
            }
            return false;
        };

        if (this.stick.isScanning()) {
            this.channel = channel;
            this.deviceID = 0;
            this.transmissionType = 0;

            this.statusCbk = onStatus;

            process.nextTick(() => this.emit("attached"));
        } else if (this.stick.attach(this, true)) {
            this.channel = channel;
            this.deviceID = 0;
            this.transmissionType = 0;

            this.statusCbk = onStatus;

            this.write(Messages.assignChannel(channel, type));
        } else {
            throw "cannot attach";
        }
    }

    protected attach(channel: number, type: string, deviceID: number, deviceType: number, transmissionType: number, timeout: number, period: number, frequency: number) {
        if (this.channel !== undefined) {
            throw "already attached";
        }
        if (!this.stick.attach(this, false)) {
            throw "cannot attach";
        }
        this.channel = channel;
        this.deviceID = deviceID;
        this.transmissionType = transmissionType;

        const onStatus = status => {
            switch (status.msg) {
                case Constants.MESSAGE_RF:
                    switch (status.code) {
                        case Constants.EVENT_CHANNEL_CLOSED:
                        case Constants.EVENT_RX_FAIL_GO_TO_SEARCH:
                            this.write(Messages.unassignChannel(channel));
                            return true;
                        case Constants.EVENT_TRANSFER_TX_COMPLETED:
                        case Constants.EVENT_TRANSFER_TX_FAILED:
                        case Constants.EVENT_RX_FAIL:
                        case Constants.INVALID_SCAN_TX_CHANNEL:
                            const mc = this.msgQueue.shift();
                            if (mc && mc.cbk) {
                                mc.cbk(status.code === Constants.EVENT_TRANSFER_TX_COMPLETED);
                            }
                            if (this.msgQueue.length) {
                                this.write(this.msgQueue[0].msg);
                            }
                            return true;
                        default:
                            break;
                    }
                    break;
                case Constants.MESSAGE_CHANNEL_ASSIGN:
                    this.write(Messages.setDevice(channel, deviceID, deviceType, transmissionType));
                    return true;
                case Constants.MESSAGE_CHANNEL_ID:
                    this.write(Messages.searchChannel(channel, timeout));
                    return true;
                case Constants.MESSAGE_CHANNEL_SEARCH_TIMEOUT:
                    this.write(Messages.setFrequency(channel, frequency));
                    return true;
                case Constants.MESSAGE_CHANNEL_FREQUENCY:
                    this.write(Messages.setPeriod(channel, period));
                    return true;
                case Constants.MESSAGE_CHANNEL_PERIOD:
                    this.write(Messages.libConfig(channel, 0xe0));
                    return true;
                case Constants.MESSAGE_LIB_CONFIG:
                    this.write(Messages.openChannel(channel));
                    return true;
                case Constants.MESSAGE_CHANNEL_OPEN:
                    process.nextTick(() => this.emit("attached"));
                    return true;
                case Constants.MESSAGE_CHANNEL_CLOSE:
                    return true;
                case Constants.MESSAGE_CHANNEL_UNASSIGN:
                    this.statusCbk = undefined;
                    this.channel = undefined;
                    process.nextTick(() => this.emit("detached"));
                    return true;
                case Constants.MESSAGE_CHANNEL_ACKNOWLEDGED_DATA:
                    return status.code === Constants.TRANSFER_IN_PROGRESS;
                default:
                    break;
            }
            return false;
        };

        this.statusCbk = onStatus;

        this.write(Messages.assignChannel(channel, type));
    }

    public detach() {
        if (this.channel === undefined) {
            return;
        }
        this.write(Messages.closeChannel(this.channel));
        if (!this.stick.detach(this)) {
            throw "error detaching";
        }
    }

    protected write(data: Buffer) {
        this.stick.write(data);
    }

    private handleEventMessages(data: Buffer) {
        const messageID = data.readUInt8(Messages.BUFFER_INDEX_MSG_TYPE);
        const channel = data.readUInt8(Messages.BUFFER_INDEX_CHANNEL_NUM);

        if (channel === this.channel) {
            if (messageID === Constants.MESSAGE_CHANNEL_EVENT) {
                const status = {
                    msg: data.readUInt8(Messages.BUFFER_INDEX_MSG_DATA),
                    code: data.readUInt8(Messages.BUFFER_INDEX_MSG_DATA + 1),
                };

                const handled = this.statusCbk && this.statusCbk(status);
                if (!handled) {
                    console.log("Unhandled event: " + data.toString("hex"));
                    this.emit("eventData", {
                        message: data.readUInt8(Messages.BUFFER_INDEX_MSG_DATA),
                        code: data.readUInt8(Messages.BUFFER_INDEX_MSG_DATA + 1),
                    });
                }
            } else if (this.decodeDataCbk) {
                this.decodeDataCbk(data);
            }
        }
    }

    protected send(data: Buffer, cbk?: SendCallback) {
        this.msgQueue.push({ msg: data, cbk });
        if (this.msgQueue.length === 1) {
            this.write(data);
        }
    }
}
