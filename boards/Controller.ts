﻿import * as extend from 'extend';
import * as fs from 'fs';
import * as path from 'path';
import { setTimeout } from 'timers';
import * as util from 'util';

import { connBroker, ConnectionBindings, ServerConnection } from '../connections/Bindings';
import { AnalogDevices, DeviceStatus } from '../devices/AnalogDevices';
import { gpioCont } from '../gpio/Gpio-Controller';
import { i2c } from '../i2c-bus/I2cBus';
import { logger } from '../logger/Logger';
import { PinDefinitions } from '../pinouts/Pinouts';
import { spi0, spi1, SpiAdcChannel } from '../spi-adc/SpiAdcBus';
import { SpiAdcChips } from '../spi-adc/SpiAdcChips';
import { webApp } from '../web/Server';
import { utils, valueMap, vMaps } from './Constants';

interface IConfigItemCollection {
    set(data);
    clear();
}
export class DeviceBinding {
    public type: string;
    public busId: number;
    public deviceId: number;
    public binding: string;
    public typeId: number; // for generic devices
    public id: number; // for generic devices
    public params: string[];
    constructor(binding: string) {
        let arr = binding.split(':');
        this.type = arr[0];
        this.busId = this.typeId = parseInt(arr[1], 10);
        this.deviceId = this.id = parseInt(arr[2], 10);
        this.params = arr.length > 2 ? arr.slice(3) : [];
        this.binding = binding;
    }
}
export class ConfigItem {
    constructor(data: any, name?: string) {
        if (typeof name === 'undefined') {
            this.data = data;
            this.initData(data);
        }
        else {
            this.data = data[name];
            this.initData(data[name]);
        }
        this.dataName = name;
    }
    public dataName: string;
    public hasChanged: boolean = false;
    protected initData(data?: any) { return data; }
    protected data: any;
    protected setDataVal(name, val, persist?: boolean) {
        if (this.data[name] !== val) {
            this.data[name] = val;
            if (typeof persist === 'undefined' || persist) this.hasChanged = true;
        }
        else if (typeof persist !== 'undefined' && persist) this.hasChanged = true;

    }
    protected setMapVal(name, val, map: valueMap, persist?: boolean) {
        if (typeof val === 'number') {
            // Map this to the string value.
            let m = map.transform(val);
            this.setDataVal(name, m.name, persist);
        }
        else if (typeof val === 'string') this.setDataVal(name, val, persist);
        else if (typeof val === 'undefined') this.setDataVal(name, val, persist);
        else if (typeof val.val === 'number') this.setMapVal(name, val.val, map, persist);
        else if (typeof val.name === 'string') this.setDataVal(name, val.name, persist);
        else this.setDataVal(name, val, persist);
    }
    protected getMapVal(val, map: valueMap) {
        if (typeof val === 'number') return map.transform(val);
        return map.transformByName(val);
    }
    public getValue(prop: string) {
        return this.data[prop];
    }
    public calcMedian(prop, values: any[]) {
        let arr = [];
        for (let i = 0; i < values.length; i++) {
            if (typeof values[i] === 'number') arr.push(values[i]);
        }
        if (arr.length > 0) {
            let mid = Math.floor(arr.length / 2);
            let nums = [...arr].sort((a, b) => a - b);
            return arr.length % 2 !== 0 ? nums[mid] : ((nums[mid - 1] + nums[mid]) / 2);
        }
        return arr[0];
    }
    public get(bCopy?: boolean): any { return bCopy ? JSON.parse(JSON.stringify(this.data)) : this.data; }
    public getExtended(): any { return this.get(true); }
    public getProperties(): string[] {
        let props = [];
        let obj = this;
        let that = obj;

        do {
            Object.getOwnPropertyNames(obj).forEach((prop) => {
                try {
                    if (props.indexOf(prop) === -1 && typeof that[prop] !== 'function') props.push(prop);
                } catch (err) { }

            });
        } while (obj = Object.getPrototypeOf(obj));
        return props;
    }
    public set(data: any) {
        //let op = Object.getOwnPropertyNames(Object.getPrototypeOf(this));
        let op = this.getProperties();
        for (let i in op) {
            let prop = op[i];
            if (typeof this[prop] === 'function') continue;
            if (prop.startsWith('_')) continue;
            if (typeof data[prop] !== 'undefined') {
                if (this[prop] instanceof ConfigItemCollection)
                    ((this[prop] as unknown) as IConfigItemCollection).set(data[prop]);
                else if (this[prop] instanceof ConfigItem)
                    ((this[prop] as unknown) as ConfigItem).set(data[prop]);
                else {
                    if (typeof this[prop] === null || typeof data[prop] === null) continue;
                    this[prop] = data[prop];
                }
            }
        }
    }
}
export class ConfigItemCollection<T> implements IConfigItemCollection {
    protected data: any;
    protected name: string;
    constructor(data: [], name: string) {
        if (typeof data[name] === 'undefined') data[name] = [];
        this.data = data[name];
        this.name = name;
    }
    public getItemByIndex(ndx: number, add?: boolean, data?: any): T {
        if (this.data.length > ndx) return this.createItem(this.data[ndx]);
        if (typeof add !== 'undefined' && add)
            return this.add(extend({}, { id: ndx + 1 }, data));
        return this.createItem(extend({}, { id: ndx + 1 }, data));
    }
    public getItemById(id: number | string, add?: boolean, data?: any): T {
        let itm = this.find(elem => elem.id === id && typeof elem.id !== 'undefined');
        if (typeof itm !== 'undefined') return itm;
        if (typeof add !== 'undefined' && add) return this.add(data || { id: id });
        return this.createItem(data || { id: id });

    }
    public removeItemById(id: number | string): T {
        let rem: T = null;
        for (let i = this.data.length - 1; i >= 0; i--)
            if (typeof this.data[i].id !== 'undefined' && this.data[i].id === id) {
                rem = this.data.splice(i, 1);
                return rem;
            }
        return rem;
    }
    public set(data) {
        if (typeof data !== 'undefined') {
            if (Array.isArray(data)) {
                this.clear();
                for (let i = 0; i < data.length; i++) {
                    // We are getting clever here in that we are simply adding the object and the add method
                    // should take care of hooking it all up.
                    let obj = (this.getItemByIndex(i, true) as unknown) as ConfigItem;
                    obj.set(data[i]);
                }
            }
        }
    }
    public removeItemByIndex(ndx: number) {
        this.data.splice(ndx, 1);
    }
    // Finds an item and returns undefined if it doesn't exist.
    public find(f: (value: any, index?: number, obj?: any) => boolean): T {
        let itm = this.data.find(f);
        if (typeof itm !== 'undefined') return this.createItem(itm);
    }
    // This will return a new collection of this type. NOTE: This is a separate object but the data is still attached to the
    // overall configuration.  This meanse that changes made to the objects in the collection will reflect in the configuration.
    // HOWEVER, any of the array manipulation methods like removeItemBy..., add..., or creation methods will not modify the configuration.
    public filter(f: (value: any, index?: any, array?: any[]) => []): ConfigItemCollection<T> {
        return new ConfigItemCollection<T>(this.data.filter(f), this.name);
    }
    public toArray() {
        let arr = [];
        if (typeof this.data !== 'undefined') {
            for (let i = 0; i < this.data.length; i++) {
                arr.push(this.createItem(this.data[i]));
            }
        }
        return arr;
    }
    public toExtendedArray() {
        let arr = [];
        if (typeof this.data !== 'undefined') {
            for (let i = 0; i < this.data.length; i++) {
                arr.push(((this.createItem(this.data[i]) as unknown) as ConfigItem).getExtended());
            }
        }
        return arr;
    }
    public createItem(data: any): T { return (new ConfigItem(data) as unknown) as T; }
    public clear() { this.data.length = 0; }
    public get length(): number { return typeof this.data !== 'undefined' ? this.data.length : 0; }
    public set length(val: number) { if (typeof val !== 'undefined' && typeof this.data !== 'undefined') this.data.length = val; }
    public add(obj: any): T { let ndx = this.data.push(obj) - 1; return this.createItem(this.data[ndx]); }
    public get(): any { return this.data; }
    public emitEquipmentChange() { webApp.emitToClients(this.name, this.data); }
    public sortByName() {
        this.sort((a, b) => {
            return a.name > b.name ? 1 : a.name !== b.name ? -1 : 0;
        });
    }
    public sortById() { this.sort((a, b) => { return a.id > b.id ? 1 : a.id !== b.id ? -1 : 0; }); }
    public sort(fn: (a, b) => number) { this.data.sort(fn); }
    public getMaxId(activeOnly?: boolean, defId?: number) {
        let maxId;
        for (let i = 0; i < this.data.length; i++) {
            if (typeof this.data[i].id !== 'undefined') {
                if (activeOnly === true && this.data[i].isActive === false) continue;
                maxId = Math.max(maxId || 0, this.data[i].id);
            }
        }
        return typeof maxId !== 'undefined' ? maxId : defId;
    }
    public getMinId(activeOnly?: boolean, defId?: number) {
        let minId;
        for (let i = 0; i < this.data.length; i++) {
            if (typeof this.data[i].id !== 'undefined') {
                if (typeof activeOnly !== 'undefined' && this.data[i].isActive === false) continue;
                minId = Math.min(minId || this.data[i].id, this.data[i].id);
            }
        }
        return typeof minId !== 'undefined' ? minId : defId;
    }
}

export class Controller extends ConfigItem {
    constructor(data) { super(data); this.cfgPath = path.posix.join(process.cwd(), '/data/controllerConfig.json'); }
    public init() {
        let cfg = this.loadConfigFile(this.cfgPath, {});
        let cfgDefault = this.loadConfigFile(path.posix.join(process.cwd(), '/defaultController.json'), {});
        cfg = extend(true, {}, cfgDefault, cfg);
        let cfgVer = 1;
        this.data = this.onchange(cfg, () => { this.dirty = true; });
        this.gpio = new Gpio(this.data, 'gpio');
        if (typeof this.data.configVersion === 'undefined') {
            this.gpio.upgrade(this.data.ver);
        }
        this.spi0 = new SpiController(this.data, 'spi0');
        this.spi1 = new SpiController(this.data, 'spi1');
        this.i2c = new I2cController(this.data, 'i2c');
        this.genericDevices = new GenericDeviceController(this.data, 'genericDevices')
        this.data.configVersion = cfgVer;
        this.connections = new ConnectionSourceCollection(this.data, 'connections');
    }
    public async stopAsync(): Promise<Controller> {
        try {
            if (this._timerChanges) clearTimeout(this._timerChanges);
            if (this._timerDirty) clearTimeout(this._timerDirty);
            if (this._isDirty) await this.persist();
            return Promise.resolve(this); // Allow chaining.
        }
        catch (err) { logger.error(`Error stopping Controller object: ${err.message}`); }
    }
    public cfgPath: string;
    protected _lastUpdated: Date;
    protected _lastPersisted: Date = new Date();
    protected _isDirty: boolean;
    protected _timerDirty: NodeJS.Timeout = null;
    protected _timerChanges: NodeJS.Timeout;
    private _pinouts;
    private _spiAdcChips;
    private _analogDevices;
    public get dirty(): boolean { return this._isDirty; }
    public set dirty(val) {
        this._isDirty = val;
        this._lastUpdated = new Date();
        this.data.lastUpdated = this._lastUpdated.toLocaleString();
        if (this._timerDirty !== null) {
            clearTimeout(this._timerDirty);
            this._timerDirty = null;
        }
        if (this._isDirty) {
            logger.silly(`Setting Dirty... ${val} ${new Date().getTime() - this._lastPersisted.getTime()}`);
            if (new Date().getTime() - this._lastPersisted.getTime() > 10000) //TODO: Set this higher as we don't need to write it every 10 seconds.
                this.persist();
            else
                this._timerDirty = setTimeout(function () { cont.persist(); }, 3000);
        }
    }
    public persist() {
        this._isDirty = false;
        logger.debug(`Persisting Configuration data... ${this.cfgPath}`);
        // Don't overwrite the configuration if we failed during the initialization.
        Promise.resolve()
            .then(() => { fs.writeFileSync(this.cfgPath, JSON.stringify(this.data, undefined, 2)); })
            .then(() => { this._lastPersisted = new Date() })
            .catch(function (err) { if (err) logger.error('Error writing controller config %s %s', err, this.cfgPath); });
    }
    public get controllerType() { return this.getMapVal(this.data.controllerType || 'raspi', vMaps.controllerTypes); }
    public set controllerType(val) {
        let old = this.data.controllerType;
        this.setMapVal('controllerType', val, vMaps.controllerTypes);
        if (old !== val) this._pinouts = undefined;
    }
    private loadConfigFile(path: string, def: any) {
        let cfg = def;
        if (fs.existsSync(path)) {
            try {
                let data = fs.readFileSync(path, 'utf8');
                cfg = JSON.parse(data || '{}');
            }
            catch (ex) {
                cfg = def;
            }
        }
        return cfg;
    }
    protected onchange = (obj, fn) => {
        const handler = {
            get(target, property, receiver) {
                // console.log(`getting prop: ${property} -- dataName? ${target.length}`)
                const val = Reflect.get(target, property, receiver);
                if (typeof val === 'function') return val.bind(receiver);
                if (typeof val === 'object' && val !== null) {
                    if (util.types.isProxy(val)) return val;
                    return new Proxy(val, handler);
                }
                return val;
            },
            set(target, property, value, receiver) {
                if (property !== 'lastUpdated' && Reflect.get(target, property, receiver) !== value) {
                    fn();
                }
                return Reflect.set(target, property, value, receiver);
            },
            deleteProperty(target, property) {
                if (property in target) Reflect.deleteProperty(target, property);
                return true;
            }
        };
        return new Proxy(obj, handler);
    };
    public gpio: Gpio;
    public spi0: SpiController;
    public spi1: SpiController;
    public i2c: I2cController;
    public genericDevices: GenericDeviceController;
    public connections: ConnectionSourceCollection;
    public get pinouts() {
        if (typeof this._pinouts === 'undefined') {
            this._pinouts = PinDefinitions.loadDefintionByName(this.controllerType.name);
        }
        return this._pinouts;
    }
    public get spiAdcChips() {
        if (typeof this._spiAdcChips === 'undefined') {
            this._spiAdcChips = SpiAdcChips.loadDefintions();
        }
        return this._spiAdcChips;
    }
    public get analogDevices() {
        //if (typeof this._analogDevices === 'undefined') {
        this._analogDevices = AnalogDevices.loadDefintions();
        //}
        return this._analogDevices;
    }
    /**************************************************
     * Api Methods
     *************************************************/
    public async setGeneralConfigAsync(data): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            this.set(data);
            resolve();
        });
    }
    public resetSpiAdcChips() { this._spiAdcChips = undefined; }
    public resetAnalogDevices() { this._analogDevices = undefined; }
    public async checkConnectionAsync(data): Promise<ConnectionSource> {
        // check for connection by type and ip
        let allCons = this.connections.toArray();
        let conns = allCons.filter(elem => elem.type.name === data.type);

        let c: ConnectionSource;
        for (let i = 0; i < conns.length; i++){
            if (conns[i].ipAddress === data.ipAddress && conns[i].port === data.port || conns[i].ipAddress === '127.0.0.1') c = conns[i] as ConnectionSource;
        }
        // if connection is undefined; or address/port do not match, and server is not localhost; set data and reset server
        if (typeof c === 'undefined' || ((c.ipAddress !== data.ipAddress || c.port !== data.port) && c.ipAddress !== '127.0.0.1')) {
            c = await this.setConnectionAsync(data);
            setTimeout(async() => {await cont.reset()},200); // reset server after req is returned
        };

        return c;
    }
    public async setConnectionAsync(data): Promise<ConnectionSource> {
        let c = this.connections.find(elem => elem.id === data.id);
        if (typeof c === 'undefined') {
            data.id = this.connections.getMaxId(false, -1) + 1;
            if (data.id === 0) data.id = 1;
        }
        return new Promise<ConnectionSource>((resolve, reject) => {
            if (typeof data.ipAddress === 'undefined' || typeof data.port === 'undefined') return reject(new Error(`setConnectionAsync: Invalid address or port: ${data}`));
            let conn = this.connections.getItemById(data.id, true);
            conn.set(data);
            resolve(conn);
        });
    }
    public async deleteConnectionAsync(id: number): Promise<ConnectionSource> {
        let conn = this.connections.getItemById(id);
        return new Promise<ConnectionSource>((resolve, reject) => {
            for (let i = 0; i < this.gpio.pins.length; i++) {
                let pin = this.gpio.pins.getItemByIndex(i);
                for (let j = 0; j < pin.triggers.length; j++)
                    pin.triggers.removeItemByIndex(j);
            }
            connBroker.deleteConnection(id);
            this.connections.removeItemById(id);
            conn.isActive = false;
            resolve(conn);
        });
    }

    public async setSpiControllerAsync(controllerId: number, data): Promise<SpiController> {
        return new Promise<SpiController>((resolve, reject) => {
            if (isNaN(controllerId) || controllerId < 0 || controllerId > 1) return reject(new Error(`Invalid SPI Controller Id ${controllerId}`));
            let spi: SpiController = cont['spi' + controllerId];
            if (typeof spi === 'undefined') return reject(new Error(`Could not find controller Id ${controllerId}`));
            spi.set(data);
            resolve(spi);
        });
    }
    public async setI2cBusAsync(data): Promise<I2cBus> {
        return new Promise<I2cBus>((resolve, reject) => {
            let bus: I2cBus;
            let id = parseInt(data.id || -1, 10);
            if (isNaN(id)) return reject(new Error(`An invalid I2C id was supplied`));
            let busNumber = parseInt(data.busNumber, 10);
            if (id < 0) {
                // We are adding a new bus.
                if (isNaN(busNumber)) return reject(new Error(`The I2C bus number was not supplied`));
                bus = this.i2c.buses.find(elem => elem.busNumber === busNumber);
                if (typeof bus !== 'undefined') return reject(new Error(`There is already an I2C bus defined at Bus #${busNumber}.`));
                bus = this.i2c.buses.getItemById((this.i2c.buses.getMaxId() || 0) + 1, true);
                bus.set(data);
            }
            else {
                bus = this.i2c.buses.find(elem => elem.id === id);
                if (typeof bus === 'undefined') return reject(new Error(`Could not find I2C bus definition at id ${id}.`));
                if (typeof data.busNumber !== 'undefined') {
                    if (isNaN(busNumber)) return reject(new Error(`An invalid bus number was supplied for the bus ${data.busNumber}`));
                    bus = this.i2c.buses.find(elem => elem.busNumber === busNumber);
                    if (bus.id !== id) return reject(new Error(`Cannot change bus number because another bus shares ${data.busNumber}`));
                }
                bus = this.i2c.buses.getItemById(id);
                bus.set(data);
            }
            resolve(bus);
        });
    }

    private sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    public async reset(): Promise<void> {
        return new Promise<void>(async (resolve, reject) => {
            try {
                await gpioCont.reset();
                await connBroker.compile();
                await spi0.resetAsync(this.spi0);
                await spi1.resetAsync(this.spi1);
                await i2c.resetAsync(this.i2c);
                await this.sleep(2000);
                logger.info(`REM Devices Reset`);
                resolve();
            }
            catch (err) { reject(err); }
        });
    }
    public getExtended() {
        let c = this.get(true);
        c.connections = [];
        c.gpio = this.gpio.getExtended();
        c.i2c = this.i2c.getExtended();
        for (let i = 0; i < this.connections.length; i++) {
            c.connections.push(this.connections.getItemByIndex(i).getExtended());
        }
        return c;
    }
    public set(data) {
        super.set(data);
        if (typeof data.spi0 !== 'undefined') this.spi0.set(data.spi0);
        if (typeof data.spi1 !== 'undefined') this.spi1.set(data.spi1);
        if (typeof data.i2c !== 'undefined') this.i2c.set(data.i2c);
    }
    public getDeviceInputs(): any[] {
        let devices = [];
        devices.push(...this.gpio.getDeviceInputs());
        devices.push(...this.spi0.getDeviceInputs());
        devices.push(...this.spi1.getDeviceInputs());
        devices.push(...this.i2c.getDeviceInputs());
        devices.push(...this.genericDevices.getDeviceInputs());
        return devices;
    }
    public getDeviceByBinding(binding: string) {
        let arr = binding.split(':');
        if (arr.length < 3) return;
        switch (arr[0]) {
            case 'spi':
                return this[`spi${arr[1]}`].channels.getItemById(parseInt(arr[2], 10));
            case 'i2c':
                return this.i2c.getDeviceById(parseInt(arr[1], 10), parseInt(arr[2], 10));
            case 'gpio':
                return this.gpio.pins.getItemById(parseInt(arr[2], 10));
            case 'generic':
                return this.genericDevices.getDevice(binding);
        }
    }
    public getInternalConnection() {
        return new ConnectionSource({ id: -1, name: 'Internal Devices', type: 'internal' });
    }
    public async setDeviceState(binding: string | DeviceBinding, data: any): Promise<any> {
        try {
            let bind = typeof binding === 'string' ? new DeviceBinding(binding) : binding;
            if (bind.type === 'i2c') {
                return await this.i2c.setDeviceState(bind, data);
            }
            else if (bind.type === 'gpio') {
                return await this.gpio.setDeviceStateAsync(bind, data);
            }
            else if (bind.type === 'spi') {
                if (isNaN(bind.busId) || bind.busId > 2)
                    return Promise.reject(new Error(`setDeviceState: Invalid spi busId ${bind.busId} - ${bind.binding}`));
            }
            else if (bind.type === 'generic') {
                return await this.genericDevices.setDeviceState(bind, data);
            }
            else {
                return Promise.reject(new Error(`setDeviceState: Unrecognized I/O Channel ${bind.type}`));
            }
        }
        catch (err) { return Promise.reject(err); }

    }
    public async getDeviceState(binding: string | DeviceBinding) {
        try {
            let bind = typeof binding === 'string' ? new DeviceBinding(binding) : binding;
            if (bind.type === 'i2c') {
                return await this.i2c.getDeviceState(bind);
            }
            else if (bind.type === 'gpio') {
                return await this.gpio.getDeviceState(bind);
            }
            else if (bind.type === 'generic') {
                return await this.genericDevices.getDeviceState(bind);
            }
            else if (bind.type === 'spi') {
                if (isNaN(bind.busId) || bind.busId > 2)
                    return Promise.reject(new Error(`getDeviceState: Invalid spi busId ${bind.busId} - ${bind.binding}`));
            }
            else {
                return Promise.reject(new Error(`getDeviceState: Unrecognized I/O Channel ${bind.type}`));
            }
        }
        catch (err) { return Promise.reject(err); }
    }
    public async getDeviceStatus(binding: string | DeviceBinding): Promise<any> {
        try {
            let bind = typeof binding === 'string' ? new DeviceBinding(binding) : binding;
            if (bind.type === 'i2c') {
                return await this.i2c.getDeviceStatus(bind);
            }
            else if (bind.type === 'gpio') {
                return await this.gpio.getDeviceStatus(bind);
            }
            else if (bind.type === 'spi') {
                if (isNaN(bind.busId) || bind.busId > 2)
                    return Promise.reject(new Error(`getDeviceStatus: Invalid spi busId ${bind.busId} - ${bind.binding}`));
                else if (bind.busId === 0) return await this.spi0.getDeviceStatus(bind);
                else if (bind.busId === 1) return await this.spi1.getDeviceStatus(bind);
                else return Promise.reject(new Error(`getDeviceStatus: Invalid spi busId ${bind.busId} - ${bind.binding}`));
            }
            else if (bind.type === 'generic') {
                return await this.genericDevices.getDeviceStatus(bind);
            }
            else {
                return Promise.reject(new Error(`getDeviceStatus: Unrecognized I/O Channel ${bind.type}`));
            }
        }
        catch (err) { return Promise.reject(err); }
    }
    public async feedDeviceValue(binding: string | DeviceBinding, data: any): Promise<any> {
        try {
            let bind = typeof binding === 'string' ? new DeviceBinding(binding) : binding;
            if (bind.type === 'i2c') {
                return await this.i2c.feedDeviceValue(bind, data);
            }
            else if (bind.type === 'gpio') {
                return await this.gpio.feedDeviceValue(bind, data);
            }
            else if (bind.type === 'spi') {
                if (isNaN(bind.busId) || bind.busId > 2)
                    return Promise.reject(new Error(`feedDeviceValue: Invalid spi busId ${bind.busId} - ${bind.binding}`));
            }
            else if (bind.type === 'generic') {
                return await this.genericDevices.feedDeviceValue(bind, data);
            }
            else {
                return Promise.reject(new Error(`feedDeviceValue: Unrecognized I/O Channel ${bind.type}`));
            }
        }
        catch (err) { return Promise.reject(err); }
    }

    public async getDevice(binding: string | DeviceBinding): Promise<any> {
        try {
            let bind = typeof binding === 'string' ? new DeviceBinding(binding) : binding;
            if (bind.type === 'i2c') {
                return await this.i2c.getDevice(bind);
            }
            else if (bind.type === 'gpio') {
                return await this.gpio.getDevice(bind);
            }
            else if (bind.type === 'spi') {
                if (isNaN(bind.busId) || bind.busId > 2)
                    return Promise.reject(new Error(`getDevice: Invalid spi busId ${bind.busId} - ${bind.binding}`));
            }
            else if (bind.type === 'generic') {
                return await this.genericDevices.getDevice(bind);
            }
            else {
                return Promise.reject(new Error(`getDevice: Unrecognized I/O Channel ${bind.type}`));
            }
        }
        catch (err) { return Promise.reject(err); }
    }
    public async setDeviceFeed(obj:any){
        let dev = this.getDeviceByBinding(obj.deviceBinding);
        let srv = connBroker.findServer(obj.connectionId);
        let type = obj.deviceBinding.split(':')[0];
        let feed;
        switch (type){
            case 'i2c':{
                // feed = (dev as I2cDevice).getDeviceFeed(obj);
                (dev as I2cDevice).setDeviceFeed(obj);
                break;
            }
            case 'gpio':{
                (dev as GpioPin).setDeviceFeed(obj);
                break;
            }
            case 'spi':
                {
                    break;
                }
            case 'generic':
                {
                    break;
                }
        }
    }
}

export class DeviceFeedCollection extends ConfigItemCollection<DeviceFeed> {
    constructor(data: any, name?: string) { super(data, name || 'feeds'); }
    public createItem(data: any): DeviceFeed { return new DeviceFeed(data); }
}
export class DeviceFeed extends ConfigItem {
    constructor(data) { super(data); }
    public initData(data?: any) {
        if (typeof this.data.isActive === 'undefined')
            this.isActive = false;
        if (typeof this.data.changesOnly === 'undefined')
            this.changesOnly = true;
        return data;
    }
    public get id(): number { return this.data.id; }
    public set id(val: number) { this.setDataVal('id', val); }
    public get connectionId(): number { return this.data.connectionId; }
    public set connectionId(val: number) { this.setDataVal('connectionId', val); }
    public get isActive(): boolean { return utils.makeBool(this.data.isActive); }
    public set isActive(val: boolean) { this.setDataVal('isActive', val); }
    public get deviceBinding(): string { return this.data.deviceBinding; }
    public set deviceBinding(val: string) { this.setDataVal('deviceBinding', val); }
    public get sendValue(): string { return this.data.sendValue; }
    public set sendValue(val: string) { this.setDataVal('sendValue', val); }
    public get sampling(): number { return this.data.sampling; }
    public set sampling(val: number) { this.setDataVal('sampling', val); }

    public get eventName(): string { return this.data.eventName; }
    public set eventName(val: string) { this.setDataVal('eventName', val); }
    public get property(): string { return this.data.property; }
    public set property(val: string) { this.setDataVal('property', val); }
    public get frequency(): number { return this.data.frequency; }
    public set frequency(val: number) { this.setDataVal('frequency', val); }
    public get changesOnly(): boolean { return utils.makeBool(this.data.changesOnly); }
    public set changesOnly(val: boolean) { this.setDataVal('changesOnly', val); }
    public get payloadExpression(): string { return this.data.payloadExpression; }
    public set payloadExpression(val: string) { this.setDataVal('payloadExpression', val); }
    public get options() { return this.data.options; }
    public set options(val) { this.setDataVal('options', val); }
    public getExtended() {
        let feed = this.get(true);
        feed.connection = this.connectionId === -1 ? cont.getInternalConnection().getExtended() : cont.connections.getItemById(this.connectionId).getExtended();
        switch (feed.connection.type.name) {
            case 'internal':
                let dev = cont.getDeviceByBinding(this.deviceBinding);
                feed.propertyDesc = typeof dev !== 'undefined' && typeof dev.name !== 'undefined' ? `[${dev.name}].${this.property}` : this.property;
                break;
            case 'mqttClient':
                feed.propertyDesc = this.eventName;
                break;
            case 'njspc':
            case 'webservice':
                feed.propertyDesc = `[${this.eventName}].${this.property}`;
                break;
            case 'generic':
                feed.propertyDesc = `Set me!`;
        }

        return feed;
    }
}
export class Feed {
    public server: ServerConnection;
    public lastSent;
    public sampling = [];
    public translatePayload: Function;
    public feed: DeviceFeed;
    constructor(feed: DeviceFeed) {
        this.server = connBroker.findServer(feed.connectionId);
        this.feed = feed;
        if (typeof feed.payloadExpression !== 'undefined' && feed.payloadExpression.length > 0)
            this.translatePayload = new Function('feed', 'value', feed.payloadExpression);
    }
    public async send(dev: any) {
        try {
            let value = dev.getValue(this.feed.sendValue);
            if (typeof value === 'undefined') value = '';
            if (!this.feed.isActive || typeof this.server === 'undefined')
                return;
            if (this.feed.sampling > 1) {
                this.sampling.push(JSON.parse(JSON.stringify(value)));
                if (this.sampling.length >= this.feed.sampling) {
                    value = dev.calcMedian(this.feed.sendValue, this.sampling);
                    await this.server.send({
                        eventName: this.feed.eventName,
                        property: this.feed.property,
                        value: typeof this.translatePayload === 'function' ? this.translatePayload(this, value) : value,
                        deviceBinding: this.feed.deviceBinding,
                        options: this.feed.options
                    });
                    // Reset the sampling and start over.
                    this.sampling.length = 0;
                }
            }
            else {
                if (!this.feed.changesOnly || (typeof value === 'object') ? this.lastSent !== JSON.stringify(value) : value !== this.lastSent) {
                    await this.server.send({
                        eventName: this.feed.eventName,
                        property: this.feed.property,
                        value: typeof this.translatePayload === 'function' ? this.translatePayload(this, value) : value,
                        deviceBinding: this.feed.deviceBinding,
                        options: this.feed.options
                    });
                }
            }
        } catch (err) { logger.error(err); }
    }
    public closeAsync() { }
}


export class Gpio extends ConfigItem {
    constructor(data, name?: string) { super(data, name || 'gpio'); }
    protected initData(data?: any) {
        if (typeof this.data.pins === 'undefined')
            this.data.pins = [];
        if (typeof this.data.exported === 'undefined')
            this.data.exported = [];
        // this.initFeeds();
        return data;
    }
    public upgrade(ver) { this.pins.upgrade(ver); }
    public setExported(gpioId: number) {
        if (this.data.exported.find(elem => elem === gpioId) === undefined) {
            this.data.exported.push(gpioId);
            return false;
        }
        return true;
    }
    public isExported(gpioId: number) { return this.exported.indexOf(gpioId) >= 0; }
    public setUnexported(gpioId: number) {
        let ndx = this.data.exported.indexOf(gpioId);
        let bExported = false;
        while (ndx >= 0) {
            this.data.exported.splice(ndx, 1);
            ndx = this.data.exported.indexOf(gpioId);
            bExported = true;
        }
        return bExported;
    }
    public get exported(): number[] { if (typeof this.data.exported === 'undefined') this.data.exported = []; return this.data.exported; }
    public set exported(val: number[]) { this.data.exported.length = 0; this.data.exported.push.apply(this.data.exported, val); }
    public get pins(): GpioPinCollection { return new GpioPinCollection(this.data, 'pins'); }
    public getDeviceInputs(): any[] {
        let devices = [];
        for (let i = 0; i < this.pins.length; i++) {
            let pin = this.pins.getItemByIndex(i);
            if (pin.isActive)
                devices.push({ uid: `gpio:0:${pin.id}`, id: pin.id, name: `Gpio Pin #${pin.headerId}-${pin.id}`, type: 'gpio', bindings: [{ name: 'state', desc: 'State of the Pin', type: 'boolean' }] });
        }
        return devices;
    }
    public async setPinAsync(headerId: number, pinId: number, data): Promise<GpioPin> {
        return await this.pins.getPinById(headerId, pinId, true).setPinAsync(data);
    }
    public async jogPinAsync(headerId: number, pinId: number, data): Promise<GpioPin> {
        return await this.pins.getPinById(headerId, pinId, true).jogPinAsync(data);
    }
    public async setPinStateAsync(headerId: number, gpioId: number, data): Promise<GpioPin> {
        let pin: GpioPin;
        if (isNaN(gpioId)) {
            let pinId = parseInt(data.pinId || data.id, 10);
            pin = this.pins.getPinById(headerId, pinId, false);
        }
        else {
            let pinouts = cont.pinouts;
            for (let i = 0; i < pinouts.headers.length; i++) {
                let head = pinouts.headers[i];
                if (isNaN(headerId) || headerId === head.id) {
                    let p = head.pins.find(elem => elem.gpioId === gpioId);
                    if (typeof p !== 'undefined') {
                        headerId = head.id;
                        pin = this.pins.getPinById(head.id, p.id);
                        break;
                    }
                }
            }
        }
        if (typeof pin !== 'undefined' && pin.isActive) {
            if (typeof data === 'object' && Array.isArray(data) && data.length > 0) {
                return await pin.runPinSequenceAsync(data);
            }
            return await pin.setPinStateAsync(utils.makeBool(data.state) ? 'on' : 'off');
        }
        else return Promise.reject(new Error(`Cannot set pin state: Unidentified Pin # -- ${JSON.stringify(data)}`));
    }
    public async setPinTriggerAsync(headerId: number, pinId: number, data): Promise<GpioPinTrigger> {
        let pin = this.pins.getPinById(headerId, pinId, true);
        return await pin.setPinTriggerAsync(data);
    }

    public async deletePinTriggerAsync(headerId: number, pinId: number, data): Promise<GpioPin> {
        return await this.pins.getPinById(headerId, pinId, true).deletePinTriggerAsync(data);
    }

    public async setDeviceStateAsync(binding: string | DeviceBinding, data: any) {
        try {
            let bind = typeof binding === 'string' ? new DeviceBinding(binding) : binding;
            // Find the pinId.
            if (isNaN(bind.deviceId))
                return Promise.reject(new Error(`setDeviceState: Invalid pin #${bind.binding}`));
            let pin = this.pins.find(elem => elem.id === bind.deviceId);
            if (typeof pin === 'undefined')
                return Promise.reject(new Error(`setDeviceState: Pin #${bind.deviceId} not found.`));
            return await pin.setDeviceState(data);
        }
        catch (err) { return Promise.reject(new Error(`Could not set gpio state: ${err}`)); }
    }
    public async feedDeviceValue(binding: string | DeviceBinding, data: any) {
        try {
            let bind = typeof binding === 'string' ? new DeviceBinding(binding) : binding;
            // Find the pinId.
            if (isNaN(bind.deviceId))
                return Promise.reject(new Error(`feedDeviceValue: Invalid pin #${bind.binding}`));
            let pin = this.pins.find(elem => elem.id === bind.deviceId);
            if (typeof pin === 'undefined')
                return Promise.reject(new Error(`feedDeviceValue: Pin #${bind.deviceId} not found.`));
            return await pin.feedDeviceValue(bind, data);
        }
        catch (err) { return Promise.reject(new Error(`Could not feed gpio value: ${err}`)); }
    }

    public async getDevice(binding: string | DeviceBinding) {
        try {
            let bind = typeof binding === 'string' ? new DeviceBinding(binding) : binding;
            // Find the pinId.
            if (isNaN(bind.deviceId))
                return Promise.reject(new Error(`getDevice: Invalid pin #${bind.binding}`));
            let pin = this.pins.find(elem => elem.id === bind.deviceId);
            if (typeof pin === 'undefined')
                return Promise.reject(new Error(`getDevice: Pin #${bind.deviceId} not found.`));
            return pin;
        }
        catch (err) { return Promise.reject(new Error(`Could not set gpio state: ${err}`)); }
    }
    public async getDeviceStatus(binding: string | DeviceBinding) {
        try {
            let bind = typeof binding === 'string' ? new DeviceBinding(binding) : binding;
            // Find the pinId.
            if (isNaN(bind.deviceId))
                return Promise.reject(new Error(`getDeviceStatus: Invalid pin #${bind.binding}`));
            let pin = this.pins.find(elem => elem.id === bind.deviceId);
            if (typeof pin === 'undefined')
                return Promise.reject(new Error(`getDeviceStatus: Pin #${bind.deviceId} not found.`));
            return pin.getDeviceStatus();
        }
        catch (err) { return Promise.reject(new Error(`Could not set gpio state: ${err}`)); }
    }
    public async getDeviceState(binding: string | DeviceBinding) {
        try {
            let bind = typeof binding === 'string' ? new DeviceBinding(binding) : binding;
            // Find the pinId.
            if (isNaN(bind.deviceId))
                return Promise.reject(new Error(`getDeviceState: Invalid pin #${bind.binding}`));
            let pin = this.pins.find(elem => elem.id === bind.deviceId);
            if (typeof pin === 'undefined')
                return Promise.reject(new Error(`getDeviceState: Pin #${bind.deviceId} not found.`));
            return { status: pin.getDeviceStatus(), state: pin.state };
        }
        catch (err) { return Promise.reject(new Error(`Could not set gpio state: ${err}`)); }
    }
    public async setDeviceFeed(data): Promise<DeviceFeedCollection> {
        try {
            if (typeof data.pinId === 'undefined')
                return Promise.reject(new Error(`Feed device pin id was not provided.`));
            let pinId = (typeof data.pinId !== 'undefined') ? parseInt(data.pinId, 10) : undefined;
            let dev = this.pins.getItemById(pinId);
            await dev.setDeviceFeed(data);
            dev.initFeeds();
            return Promise.resolve(dev.feeds);
        }
        catch (err) { return Promise.reject(err); }
    }
    public async deleteDeviceFeed(data): Promise<DeviceFeedCollection> {
        try {
            if (typeof data.pinId === 'undefined')
                return Promise.reject(new Error(`Feed device pin id was not provided.`));
            let devId = (typeof data.pinId !== 'undefined') ? parseInt(data.pinId, 10) : undefined;
            let dev = this.pins.getItemById(devId);
            await dev.deleteDeviceFeed(data);
            dev.initFeeds();
            return Promise.resolve(dev.feeds);
        }
        catch (err) { return Promise.reject(err); }
    }
    public emitFeeds(pinId, headerId) {
        let dev = this.pins.getItemById(pinId);
        setTimeout(() => { dev.emitFeeds(); }, 250);
    }
}

export class GpioPinCollection extends ConfigItemCollection<GpioPin> {
    constructor(data: any, name?: string) { super(data, name || 'pins'); }
    public createItem(data: any): GpioPin { return new GpioPin(data); }
    public upgrade(ver) {
        for (let i = 0; i < this.data.length; i++) {
            let pin = this.getItemByIndex(i);
            pin.upgrade(ver);
        }
    }
    public getPinById(headerId: number, pinId: number, add?: boolean, data?: any) {
        let pin = this.find(elem => elem.headerId === headerId && elem.id === pinId);
        if (typeof pin !== 'undefined')
            return pin;
        if (typeof add !== 'undefined' && add)
            return this.add(data || { id: pinId, headerId: headerId });
        return this.createItem(data || { id: pinId, headerId: headerId });
    }
}
export class GpioPin extends ConfigItem {
    constructor(data) { super(data); }
    protected _latchTimer: NodeJS.Timeout;
    public initData(data?: any) {
        if (typeof this.data.isInverted === 'undefined')
            this.isInverted = false;
        if (typeof this.data.direction === 'undefined')
            this.direction = 'output';
        if (typeof this.data.triggers === 'undefined')
            this.data.triggers = [];
        return data;
    }
    public upgrade(ver) {
        this.triggers.upgrade(ver);
    }
    public get id(): number { return this.data.id; }
    public set id(val: number) { this.setDataVal('id', val); }
    public get isActive(): boolean { return utils.makeBool(this.data.isActive); }
    public set isActive(val: boolean) { this.setDataVal('isActive', val); }
    public get headerId(): number { return this.data.headerId; }
    public set headerId(val: number) { this.setDataVal('headerId', val); }
    public get direction() { return this.getMapVal(this.data.direction, vMaps.pinDirections); }
    public set direction(val) { this.setMapVal('direction', val, vMaps.pinDirections); }
    public get type() { return this.getMapVal(this.data.type, vMaps.pinTypes); }
    public set type(val) { this.setMapVal('type', val, vMaps.pinTypes); }
    public get isInverted(): boolean { return utils.makeBool(this.data.isInverted); }
    public set isInverted(val: boolean) { this.setDataVal('isInverted', val); }
    public get state() { return this.getMapVal(this.data.state || 'unknown', vMaps.pinStates); }
    public set state(val) { this.setMapVal('state', val, vMaps.pinStates); }
    public get name(): string { return typeof this.data.name === 'undefined' ? this.data.name = `Pin #${this.headerId}-${this.id}` : this.data.name; }
    public set name(val: string) { this.setDataVal('name', val); }
    public get debounceTimeout(): number { return this.data.debounceTimeout; }
    public set debounceTimeout(val: number) { this.setDataVal('debounceTimeout', val); }
    public get triggers(): GpioPinTriggerCollection { return new GpioPinTriggerCollection(this.data, 'triggers'); }
    public get feeds(): DeviceFeedCollection { return new DeviceFeedCollection(this.data, 'feeds'); }
    public async setPinAsync(data: any) {
        try {
            this.set(data);
            if (!this.isOutput) {
                if (this.triggers.length > 0) {
                    for (let i = this.triggers.length - 1; i >= 0; i--) {
                        this.triggers.removeItemByIndex(i);
                    }
                    await gpioCont.resetPinTriggers(this.headerId, this.id);
                }
            }
            gpioCont.initPin(this);
            return this;
        } catch (err) { return Promise.reject(new Error(`Error saving pin ${this.headerId}-${this.id}`)); }
    }
    public async jogPinAsync(data: any) {
        return new Promise<GpioPin>(async (resolve, reject) => {
            if (!this.isOutput) return Promise.reject(new Error(`setDeviceState: GPIO Pin #${this.headerId} - ${this.id} is not an output pin`));
            if (!this.isActive) {
                logger.error(`GPIO Pin #${data.headerId} ${data.pinId} is not active.`);
                reject(new Error(`GPIO Pin #${data.headerId} ${data.pinId} is not active.`));
            }
            let currentState = utils.makeBool(this.state.gpio);
            let state = data.state !== 'undefined' ? utils.makeBool(data.state) : this.state.gpio === 'on' ? true : false;
            let times = data.times || 1;
            if (currentState === state) {
                await this.setPinStateAsync(!state);
                await new Promise<void>((resolve, reject) => setTimeout(() => { resolve(); }, data.delay || 100));
            }
            while (times > 0) {
                await this.setPinStateAsync(state);
                await new Promise<void>((resolve, reject) => setTimeout(() => { resolve(); }, data.delay || 100));
                if (times > 1) await await this.setPinStateAsync(!state);
                times--;
            }
        });
    }
    public async runPinSequenceAsync(data: any[]): Promise<GpioPin> {
        return new Promise<GpioPin>(async (resolve, reject) => {
            if (!this.isOutput) return Promise.reject(new Error(`runPinSequence: GPIO Pin #${this.headerId} - ${this.id} is not an output pin`));
            let onv = this.getMapVal('on', vMaps.pinStates);
            let offv = this.getMapVal('off', vMaps.pinStates);
            logger.debug(`Starting sequence: ${data.length}`);
            for (let i = 0; i < data.length; i++) {
                let seq = data[i];
                let mv = utils.makeBool(seq.state || seq.isOn) ? onv : offv;
                await gpioCont.writePinAsync(this.headerId, this.id, mv.gpio);
                logger.debug(`Setting sequence val:${mv.gpio}`);
                if (seq.timeout) await utils.wait(seq.timeout);
            }
            resolve(this);
        })

    }
    public async setPinStateAsync(state: string | boolean | number): Promise<GpioPin> {
        return new Promise<GpioPin>(async (resolve, reject) => {
            if (!this.isOutput) return Promise.reject(new Error(`setDeviceState: GPIO Pin #${this.headerId} - ${this.id} is not an output pin`));

            let mv = this.getMapVal(utils.makeBool(state) ? 'on' : 'off', vMaps.pinStates);
            if (typeof mv !== 'undefined') {
                if (mv.gpio !== 'undefined' && this.isActive) {
                    await gpioCont.writePinAsync(this.headerId, this.id, mv.gpio)
                    this.setMapVal('state', state, vMaps.pinStates);
                }
                else
                    this.setMapVal('state', state, vMaps.pinStates);
            }
            resolve(this);
        })
    }
    public _feeds: Feed[] = [];
    public initFeeds() {
        this._feeds = [];
        for (let i = 0; i < this.feeds.length; i++) {
            let f = this.feeds.getItemByIndex(i);
            this._feeds.push(new Feed(f));
        }
    }
    public async emitFeeds() {
        try {
            this.initFeeds();
            for (let i = 0; i < this._feeds.length; i++) {
                await this._feeds[i].send(this);
            }
        } catch (err) { logger.error(err); }
    }
    public getExtended() {
        let pin = this.get(true);
        pin.triggers = [];
        pin.feeds = [];
        let pinouts = cont.pinouts;
        let header = pinouts.headers.find(elem => elem.id === this.headerId);
        let pinout = typeof header !== 'undefined' ? header.pins.find(elem => elem.id === this.id) : {};
        pin = extend(true, pin, pinout, { header: header });
        pin.type = this.type;
        pin.state = this.state;
        pin.isActive = this.isActive;
        pin.isExported = typeof cont.gpio.exported.find(elem => elem === pin.gpioId) !== 'undefined';
        pin.name = this.name;
        pin.pinoutName = pinout.name;
        for (let i = 0; i < this.triggers.length; i++) {
            pin.triggers.push(this.triggers.getItemByIndex(i).getExtended());
        }
        for (let i = 0; i < this.feeds.length; i++) {
            pin.feeds.push(this.feeds.getItemByIndex(i).getExtended());
        }
        return pin;
    }
    public get isOutput(): boolean { return typeof this.data.direction === 'string' ? this.data.direction.indexOf('output') >= 0 : false; }
    public async getDeviceStatus(): Promise<any> {
        try {
            let p = gpioCont.pins.find(elem => elem.headerId === this.headerId && elem.pinId === this.id);
            if (typeof p === 'undefined')
                return Promise.reject(new Error(`getDeviceStatus: Could not find active Pin #${this.headerId}-${this.id}`));
            return p.deviceStatus;
        }
        catch (err) { return Promise.reject(`getDeviceStatus: Error getting Pin #${this.headerId}-${this.id} status: ${err}`); }
    }
    public async setDeviceState(data: any): Promise<any> {
        try {
            // We need to know what relay we are referring to.
            // gpio:1:47 For GPIO the headerId is the busId and the Pin # is the deviceId.
            // Check to see if the pin is an output pin.  If it is an input only then we have us a problem
            if (!this.isOutput) return Promise.reject(new Error(`setDeviceState: GPIO Pin #${this.headerId} - ${this.id} is not an output pin`));
            // At this point we have the current value.
            let latch = (typeof data.latch !== 'undefined') ? parseInt(data.latch, 10) : -1;
            if (isNaN(latch))
                return Promise.reject(new Error(`setDeviceState: GPIO Pin #${this.headerId} - ${this.id} latch data is invalid ${data.latch}.`));
            let oldState = await gpioCont.readPinAsync(this.headerId, this.id);

            // Now that the state has been read lets set its state.
            let newState = typeof data.state !== 'undefined' ? utils.makeBool(data.state) : typeof data.isOn !== 'undefined' ? utils.makeBool(data.isOn) : typeof data !== 'undefined' ? utils.makeBool(data) : false;
            if (typeof data === 'object' && Array.isArray(data) && data.length > 0) {
                await this.runPinSequenceAsync(data);
                newState = await gpioCont.readPinAsync(this.headerId, this.id) ? true : false;
            }
            else {
                await gpioCont.writePinAsync(this.headerId, this.id, newState ? 1 : 0, latch);
            }
            let vmState = vMaps.pinStates.transform(newState ? 1 : 0);
            this.setDataVal('state', vmState.name);
            return {
                id: this.id,
                headerId: this.headerId,
                name: this.name,
                enabled: this.isActive,
                oldState: oldState > 0,
                state: newState
            };
        }
        catch (err) { return Promise.reject(`setDeviceState: Error setting pin state: ${err}`); }
    }
    public async feedDeviceValue(binding: string | DeviceBinding, data: any): Promise<any> {
        try {
            let bind = (typeof binding === 'string') ? new DeviceBinding(binding) : binding;
            // We need to know what relay we are referring to.
            // gpio:1:47 For GPIO the headerId is the busId and the Pin # is the deviceId.
            // Check to see if the pin is an output pin.  If it is an input only then we have us a problem
            if (!this.isOutput) return Promise.reject(new Error(`feedDeviceValue: GPIO Pin #${this.headerId} - ${this.id} is not an output pin`));
            // At this point we have the current value.
            let latch = (typeof data.latch !== 'undefined') ? parseInt(data.latch, 10) : -1;
            if (isNaN(latch))
                return Promise.reject(`feedDeviceValue: GPIO Pin #${this.headerId} - ${this.id} latch data is invalid ${data.latch}.`);
            let oldState = await gpioCont.readPinAsync(this.headerId, this.id);
            // Now that the state has been read lets set its state.
            let newState = typeof data.state !== 'undefined' ? utils.makeBool(data.state) : typeof data.isOn !== 'undefined' ? utils.makeBool(data.isOn) : false;
            await gpioCont.writePinAsync(this.headerId, this.id, newState ? 1 : 0, latch);
            let vmState = vMaps.pinStates.transform(newState ? 1 : 0);
            this.setDataVal('state', vmState.name);
            let pin = {
                id: this.id,
                name: this.name,
                headerId: this.headerId,
                enabled: this.isActive,
                oldState: oldState > 0,
                state: newState
            };
            return pin;
        }
        catch (err) { return Promise.reject(`feedDeviceValue: Error setting pin value: ${err}`); }
    }
    public async deletePinTriggerAsync(triggerId: number): Promise<GpioPin> {
        return new Promise<GpioPin>((resolve, reject) => {
            this.triggers.removeItemById(triggerId);
            gpioCont.resetPinTriggers(this.headerId, this.id);
            resolve(this);
        });
    }
    public async setPinTriggerAsync(data): Promise<GpioPinTrigger> {
        try {
            let c = this.triggers.find(elem => elem.id === data.id);
            if (typeof c === 'undefined') {
                data.id = this.triggers.getMaxId(false, -1) + 1;
                if (data.id === 0) data.id = 1;
                c = this.triggers.getItemById(data.id, true);
            }
            let trig = await c.setPinTriggerAsync(data);
            gpioCont.resetPinTriggers(this.headerId, this.id);
            return trig;
        } catch(err) { return Promise.reject(new Error(`Error Setting pin trigger ${err.message}`)); }
    }
    public async setDeviceFeed(data): Promise<DeviceFeed> {
        try {
            let feedId = typeof data.id !== 'undefined' ? parseInt(data.id, 10) : typeof data.feedId !== 'undefined' ? parseInt(data.feedId, 10) : -1;
            if (isNaN(feedId))
                return Promise.reject(`The feed identifier is not valid.`);
            let feed: DeviceFeed;
            let connectionId;
            let connection;
            if (feedId !== -1) {
                // We are updating.
                feed = this.feeds.find(elem => elem.id === feedId);
                if (typeof feed === 'undefined')
                    return Promise.reject(`Could not find a feed by id ${feedId}`);
                connectionId = feed.connectionId;
            }
            else {
                // We are adding.
                feed = this.getDeviceFeed(data); // try to find feed with matching props; useful if data sent from njsPC
                feedId = (this.feeds.getMaxId() || 0) + 1;
                connectionId = parseInt(data.connectionId, 10);
                if (isNaN(connectionId))
                    return Promise.reject(new Error(`The feed connection identifier was not supplied.`));
            }
            connection = connectionId !== -1 ? cont.connections.find(elem => elem.id === connectionId) : undefined;
            if (connectionId !== -1 && typeof connection === 'undefined')
                return Promise.reject(`The feed connection was not found at id ${connectionId}`);
            feed = this.feeds.getItemById(feedId, true);
            feed.connectionId = connectionId;
            feed.set(data);
            feed.id = feedId;
            return Promise.resolve(feed);
        }
        catch (err) { return Promise.reject(err); }
    }
    public async deleteDeviceFeed(data): Promise<DeviceFeed> {
        try {
            let feedId = typeof data.id !== 'undefined' ? parseInt(data.id, 10) : typeof data.feedId !== 'undefined' ? parseInt(data.feedId, 10) : -1;
            if (isNaN(feedId))
                return Promise.reject(`The feed identifier is not valid.`);
            let feed: DeviceFeed;
            feed = this.feeds.getItemById(feedId);
            this.feeds.removeItemById(feedId);
            return Promise.resolve(feed);
        }
        catch (err) { return Promise.reject(err); }
    }
    public getDeviceFeed(data): DeviceFeed {
        try {
            let feedId = typeof data.id !== 'undefined' ? parseInt(data.id, 10) : typeof data.feedId !== 'undefined' ? parseInt(data.feedId, 10) : -1;
            if (isNaN(feedId)) return;
            let feed: DeviceFeed;
            if (feedId !== -1) {
                // Search by feed id
                return this.feeds.find(elem => elem.id === feedId);
            }
            else {
                // Search by attributes
                for (let i = 0; i < this.feeds.length; i++){
                    feed = this.feeds.getItemByIndex(i);
                    if (feed.connectionId === data.connectionId &&
                        feed.sendValue === data.sendValue &&
                        (feed.eventName === data.eventName || feed.eventName === 'all') &&
                        feed.property === data.property){
                        return feed; // what if multiple matching(?)
                    }
                }
            }
        }
        catch (err) { logger.error(`getDeviceFeed GPIO: ${err};`); }
    }
}
export class DataTrigger extends ConfigItem {
    constructor(data) { super(data); }
    public initData(data?: any) {
        if (typeof this.data.isActive === 'undefined') this.isActive = false;
        if (typeof this.data.bindings === 'undefined') this.data.bindings = [];
        return data;
    }
    public get id(): number { return this.data.id; }
    public set id(val: number) { this.setDataVal('id', val); }
    public get isActive(): boolean { return utils.makeBool(this.data.isActive); }
    public set isActive(val: boolean) { this.setDataVal('isActive', val); }
    public get sourceId(): number { return this.data.sourceId; }
    public set sourceId(val: number) { this.setDataVal('sourceId', val); }
    public get eventName(): string { return this.data.eventName; }
    public set eventName(val: string) { this.setDataVal('eventName', val); }
    public get usePinId(): boolean { return utils.makeBool(this.data.usePinId); }
    public set usePinId(val: boolean) { this.setDataVal('usePinId', val); }
    public get expression(): string { return this.data.expression; }
    public set expression(val: string) { this.setDataVal('expression', val); }
    public get bindings(): DeviceTriggerBindingCollection { return new DeviceTriggerBindingCollection(this.data, 'bindings'); }
    public get filter(): string {
        let filter = '';
        let n = 0;
        let bindings = this.bindings;
        for (let i = 0; i < bindings.length; i++) {
            let b = bindings.getItemByIndex(i);
            if (!b.isActive)
                continue;
            if (n !== 0)
                filter += ' &&\r\n';
            filter += `${b.binding} ${b.operator.op} `;
            if (typeof b.bindValue === 'string')
                filter += `'${b.bindValue}'`;
            else
                filter += `${b.bindValue}`;
            n++;
        }
        if (typeof this.expression !== 'undefined' && this.expression !== '') {
            if (n > 0)
                filter += ' &&\r\n';
            filter += '<script expression>';
        }
        return filter;
    }
    public makeExpression() { return DataTrigger._makeExpression(this.data, 'data'); }
    public makeTriggerFunction() { return new Function('connection', 'trigger', 'data', DataTrigger._makeExpression(this.data, 'data')); }
    protected static _makeExpression(data, dataName) {
        let bindingCount = (typeof data.bindings !== 'undefined') ? data.bindings.filter(elem => utils.makeBool(elem.isActive) === true).length : 0;
        let expression = '';
        if (bindingCount === 0 && (typeof data.expression === 'undefined' || data.expression.length === 0)) return 'return true;';
        if (bindingCount > 0) {
            let n = 0;
            expression += 'if(!(';
            if (utils.makeBool(data.usePinId)) {
                expression += 'parseInt(data.pinId, 10) === pin.id';
                n++;
            }
            for (let i = 0; i < data.bindings.length; i++) {
                let b = data.bindings[i];
                if (!utils.makeBool(b.isActive)) continue;
                let op = vMaps.operators.transform(b.operator);
                if (n !== 0)
                    expression += ' && ';
                expression += `${dataName}.${b.binding} ${op.op} `;
                if (typeof b.bindValue === 'string')
                    expression += `'${b.bindValue}'`;
                else
                    expression += `${b.bindValue}`;
                n++;
            }
            expression += ')) return false;';
        }
        if (typeof data.expression !== 'undefined' && data.expression !== '') {
            expression += ' {' + data.expression + '}';
        }
        else if (bindingCount > 0) { expression += ' else return true;'; }
        logger.debug(`Created filter expression ${expression}`);
        return expression;
    }
}
export class GpioPinTriggerCollection extends ConfigItemCollection<GpioPinTrigger> {
    constructor(data: any, name?: string) { super(data, name || 'triggers'); }
    public createItem(data: any): GpioPinTrigger { return new GpioPinTrigger(data); }
    public upgrade(ver) {
        for (let i = 0; i < this.data.length; i++) {
            let trigger = this.getItemByIndex(i);
            trigger.upgrade(ver);
        }
    }
}
export class GpioPinTrigger extends DataTrigger {
    constructor(data) { super(data); }
    public initData(data?: any) {
        super.initData(data);
    }
    public upgrade(ver) {
        if (typeof this.data.binding !== 'undefined') {
            if (this.data.bindings.find(elem => elem.binding === this.data.binding) === undefined) {
                this.bindings.add({
                    isActive: true,
                    binding: this.data.binding,
                    operator: this.data.operator,
                    bindValue: this.data.bindValue === 'true' || this.data.bindValue === 'false' ? utils.makeBool(this.data.bindValue) : this.data.bindValue
                });
                this.data.usePinId = (typeof this.data.equipmentId === 'undefined');
            }
            this.data.equipmentId = undefined;
            this.data.operator = undefined;
            this.data.binding = undefined;
            this.data.bindValue = undefined;
        }
    }
    public get state() { return this.getMapVal(this.data.state || 0, vMaps.triggerStates); }
    public set state(val) { this.setMapVal('state', val, vMaps.triggerStates); }
    public getExtended() {
        let trigger = this.get(true);
        trigger.state = this.state;
        trigger.connection = cont.connections.getItemById(this.sourceId).getExtended();
        trigger.filter = this.filter;
        let binds = [];
        // TODO: Move this into a normalize method so that it is only done
        // once.  Probably during the upgrade process.
        // Reorganize the bindings so that they match what we get from the event.
        if (typeof this.data.bindings !== 'undefined' && typeof this.data.eventName !== 'undefined' && typeof this.data.sourceId !== 'undefined') {
            let conn = cont.connections.getItemById(this.data.sourceId);
            let bindings = ConnectionBindings.loadBindingsByConnectionType(conn.type.name);
            if (typeof bindings !== 'undefined' && typeof bindings.events !== 'undefined') {
                let event = bindings.events.find(elem => elem.name === trigger.eventName);
                if (typeof event !== 'undefined') {
                    for (let i = 0; i < event.bindings.length; i++) {
                        binds.push({ binding: event.bindings[i].binding, isActive: false });
                    }
                }
            }
        }
        for (let i = 0; i < trigger.bindings.length; i++) {
            let bind = trigger.bindings[i];
            let b = binds.find(elem => elem.binding === bind.binding);
            if (typeof b !== 'undefined') {
                b.isActive = bind.isActive;
                b.operator = bind.operator;
                b.bindValue = bind.bindValue;
            }
        }
        trigger.bindings = binds;
        return trigger;
    }
    public static validateExpression(data) {
        try {
            new Function('connection', 'pin', 'trigger', 'data', DataTrigger._makeExpression(data, 'data'));
        }
        catch (err) { return new Error(`${err} ${DataTrigger._makeExpression(data, 'data')}`); }
    }
    public makeTriggerFunction() { return new Function('connection', 'pin', 'trigger', 'data', DataTrigger._makeExpression(this.data, 'data')); }
    public async setPinTriggerAsync(data): Promise<GpioPinTrigger> {
        return new Promise<GpioPinTrigger>((resolve, reject) => {
            if (typeof data.bindings !== 'undefined' || typeof data.expression !== 'undefined' || data.expression !== '') {
                let test = extend(true, this.get(true), data);
                let err = GpioPinTrigger.validateExpression(test);
                if (typeof err !== 'undefined') {
                    logger.error(`Invalid Pin#${this.id} Trigger Expression: ${err}`);
                    return reject(new Error(`Invalid Pin#${this.id} Trigger Expression: ${err}`));
                }
            }
            this.set(data);
            resolve(this);
        });
    }
}
export class DeviceTriggerCollection extends ConfigItemCollection<DeviceTrigger> {
    constructor(data: any, name?: string) { super(data, name || 'triggers'); }
    public createItem(data: any): DeviceTrigger { return new DeviceTrigger(data); }
}
export class DeviceTrigger extends DataTrigger {
    constructor(data) { super(data); }
    public initData(data?: any) {
        if (typeof this.data.bindings === 'undefined')
            this.data.bindings = [];
        return data;
    }
    public get usePinId(): boolean { return utils.makeBool(this.data.usePinId); }
    public set usePinId(val: boolean) { this.setDataVal('usePinId', val); }
    public get state() { return this.getMapVal(this.data.state || 0, vMaps.triggerStates); }
    public set state(val) { this.setMapVal('state', val, vMaps.triggerStates); }
    public get options(): any { return typeof this.data.options === 'undefined' ? this.data.options = {} : this.data.options; }
    public set options(val: any) { this.setDataVal('options', val || {}); }
    public get channelId(): number { return this.data.channelId; }
    public set channelId(val: number) { this.setDataVal('channelId', val); }

    public get stateExpression(): string { return this.data.stateExpression; }
    public set stateExpression(val: string) { this.setDataVal('stateExpression', val); }
    public getExtended() {
        let trigger = this.get(true);
        trigger.state = this.state;
        trigger.connection = cont.connections.getItemById(this.sourceId).getExtended();
        trigger.filter = this.filter;
        let binds = [];
        // TODO: Move this into a normalize method so that it is only done
        // once.  Probably during the upgrade process.
        // Reorganize the bindings so that they match what we get from the event.
        if (typeof this.data.bindings !== 'undefined' && typeof this.data.eventName !== 'undefined' && typeof this.data.sourceId !== 'undefined') {
            let conn = cont.connections.getItemById(this.data.sourceId);
            let bindings = ConnectionBindings.loadBindingsByConnectionType(conn.type.name);
            if (typeof bindings !== 'undefined' && typeof bindings.events !== 'undefined') {
                let event = bindings.events.find(elem => elem.name === trigger.eventName);
                if (typeof event !== 'undefined') {
                    for (let i = 0; i < event.bindings.length; i++) {
                        binds.push({ binding: event.bindings[i].binding, isActive: false });
                    }
                }
            }
        }
        for (let i = 0; i < trigger.bindings.length; i++) {
            let bind = trigger.bindings[i];
            let b = binds.find(elem => elem.binding === bind.binding);
            if (typeof b !== 'undefined') {
                b.isActive = bind.isActive;
                b.operator = bind.operator;
                b.bindValue = bind.bindValue;
            }
        }
        trigger.bindings = binds;
        return trigger;
    }
    public get eventName(): string { return this.data.eventName; }
    public set eventName(val: string) { this.setDataVal('eventName', val); }
    public get expression(): string { return this.data.expression; }
    public set expression(val: string) { this.setDataVal('expression', val); }
    public get bindings(): DeviceTriggerBindingCollection { return new DeviceTriggerBindingCollection(this.data, 'bindings'); }
    public get filter(): string {
        let filter = '';
        let n = 0;
        let bindings = this.bindings;
        for (let i = 0; i < bindings.length; i++) {
            let b = bindings.getItemByIndex(i);
            if (!b.isActive)
                continue;
            if (n !== 0)
                filter += ' &&\r\n';
            filter += `${b.binding} ${b.operator.op} `;
            if (typeof b.bindValue === 'string')
                filter += `'${b.bindValue}'`;
            else
                filter += `${b.bindValue}`;
            n++;
        }
        if (typeof this.expression !== 'undefined' && this.expression !== '') {
            if (n > 0)
                filter += ' &&\r\n';
            filter += '<script expression>';
        }
        return filter;
    }
    public static validateExpression(data) {
        try {
            new Function('connection', 'device', 'trigger', 'data', DeviceTrigger._makeExpression(data, 'data'));
        }
        catch (err) { return new Error(`${err} ${DeviceTrigger._makeExpression(data, 'data')}`); }
    }
    public makeTriggerFunction() { return new Function('connection', 'device', 'trigger', 'data', DeviceTrigger._makeExpression(this.data, 'data')); }
}
export class DeviceTriggerBindingCollection extends ConfigItemCollection<DeviceTriggerBinding> {
    constructor(data: any, name?: string) { super(data, name || 'bindings'); }
    public createItem(data: any): DeviceTriggerBinding { return new DeviceTriggerBinding(data); }
}
export class DeviceTriggerBinding extends ConfigItem {
    constructor(data) { super(data); }
    public initData(data?: any) {
        if (typeof this.data.isActive === 'undefined')
            this.isActive = false;
        return data;
    }
    public get binding(): string { return this.data.binding; }
    public set binding(val: string) { this.setDataVal('binding', val); }
    public get isActive(): boolean { return utils.makeBool(this.data.isActive); }
    public set isActive(val: boolean) { this.setDataVal('isActive', val); }
    public get operator() { return this.getMapVal(this.data.operator || 0, vMaps.operators); }
    public set operator(val) { this.setMapVal('operator', val, vMaps.operators); }
    public get bindValue(): any { return this.data.bindValue; }
    public set bindValue(val: any) { this.setDataVal('bindValue', val); }
    public getExtended() {
        let exp = this.get();
        exp.operator = this.operator;
        return exp;
    }
}



export class SpiController extends ConfigItem {
    constructor(data, name: string) { super(data, name); }
    public initData(data?: any) {
        if (typeof this.data.isActive === 'undefined') this.isActive = false;
        if (typeof this.data.referenceVoltage === 'undefined') this.referenceVoltage = 3.3;
        if (typeof this.data.spiClock === 'undefined') this.spiClock = 1000;
        if (typeof this.data.channels === 'undefined') this.data.channels = [];
        return data;
    }
    public get isActive(): boolean { return utils.makeBool(this.data.isActive); }
    public set isActive(val: boolean) { this.setDataVal('isActive', val); }
    public get busNumber(): number { return this.data.busNumber; }
    public get adcChipType(): number { return this.data.adcChipType; }
    public set adcChipType(val: number) { this.setDataVal('adcChipType', val); }
    public get referenceVoltage(): number { return this.data.referenceVoltage; }
    public set referenceVoltage(val: number) { this.setDataVal('referenceVoltage', val); }
    public get spiClock(): number { return this.data.spiClock; }
    public set spiClock(val: number) { this.setDataVal('spiClock', val); }
    public get channels(): SpiChannelCollection { return new SpiChannelCollection(this.data, 'channels'); }
    public getExtended() {
        let c = this.get(true);
        c.chipType = cont.spiAdcChips.find(elem => elem.id === this.adcChipType);
        c.channels = [];
        for (let i = 0; i < this.channels.length; i++) {
            c.channels.push(this.channels.getItemByIndex(i).getExtended());
        }
        return c;
    }
    public getDeviceInputs(): any[] {
        let devices = [];
        let ad = cont.analogDevices;
        for (let i = 0; i < this.channels.length; i++) {
            let channel = this.channels.getItemByIndex(i);
            let dev;
            if (typeof channel.deviceId !== 'undefined' && channel.deviceId !== 0)
                dev = ad.find(elem => elem.id === channel.deviceId);
            if (typeof dev !== 'undefined' && typeof dev.inputs !== 'undefined') {
                devices.push({ uid: `spi:${this.busNumber}:${channel.id}`, id: channel.id, name: ad.name, deviceId: dev.id, type: 'spi', busNumber: this.busNumber, bindings: dev.inputs });
            }
        }
        return devices;
    }
    public async getDeviceStatus(binding: string | DeviceBinding): Promise<any> {
        try {
            let bind = typeof binding === 'string' ? new DeviceBinding(binding) : binding;
            if (isNaN(bind.deviceId)) return Promise.reject(new Error(`getDeviceStatus: Invalid SPI Channel ${bind.busId} ${bind.deviceId} - ${bind.binding}`));
            let device = this.channels.find(elem => elem.id === bind.deviceId);
            if (typeof device === 'undefined') return Promise.reject(new Error(`getDeviceStatus: Could not find SPI Channel ${bind.busId}:${bind.deviceId} - ${bind.binding}`));
            let dev: SpiAdcChannel;
            if (this.busNumber === 0)
                dev = spi0.channels.find(elem => bind.deviceId === elem.channel);
            else
                dev = spi1.channels.find(elem => bind.deviceId === elem.channel);
            if (typeof dev === 'undefined') return Promise.reject(new Error(`getDeviceStatus: Channel not initialized ${bind.busId} ${bind.deviceId} - ${bind.binding}`));
            return dev.deviceStatus;
        } catch (err) { return Promise.reject(err); }
    }
    public async getDeviceState(binding: string | DeviceBinding): Promise<any> {
        try {
            let bind = typeof binding === 'string' ? new DeviceBinding(binding) : binding;
            if (isNaN(bind.deviceId)) return Promise.reject(new Error(`getDeviceState: Invalid SPI Channel ${bind.busId} ${bind.deviceId} - ${bind.binding}`));
            let device = this.channels.find(elem => elem.id === bind.deviceId);
            if (typeof device === 'undefined') return Promise.reject(new Error(`getDeviceState: Could not find SPI Channel ${bind.busId}:${bind.deviceId} - ${bind.binding}`));
            let dev: SpiAdcChannel;
            if (this.busNumber === 0)
                dev = spi0.channels.find(elem => bind.deviceId === elem.channel);
            else
                dev = spi1.channels.find(elem => bind.deviceId === elem.channel);
            if (typeof dev === 'undefined') return Promise.reject(new Error(`getDeviceState: Channel not initialized ${bind.busId} ${bind.deviceId} - ${bind.binding}`));
            return { status: dev.deviceStatus, state: dev.lastVal };
        } catch (err) { return Promise.reject(err); }
    }

}
export class I2cController extends ConfigItem {
    constructor(data, name: string) { super(data, name); }
    public initData(data?: any) {
        if (typeof this.data.isActive === 'undefined') this.isActive = false;
        if (typeof this.data.buses === 'undefined') this.data.buses = [];
        if (typeof this.data.detected === 'undefined') this.data.detected = [];
        return data;
    }
    public get id(): number { return this.data.id; }
    public set id(val: number) { this.setDataVal('id', val); }
    public get isActive(): boolean { return utils.makeBool(this.data.isActive); }
    public set isActive(val: boolean) { this.setDataVal('isActive', val); }
    public get detected(): any[] { return this.data.detected; }
    public set detected(val: any[]) { this.data.detected = val; }
    public get buses(): I2cBusCollection { return new I2cBusCollection(this.data, 'buses'); }
    public getExtended() {
        let c = this.get(true);
        c.buses = this.buses.toExtendedArray();
        return c;
    }
    public async setDeviceState(binding: string | DeviceBinding, data: any): Promise<any> {
        try {
            let bind = typeof binding === 'string' ? new DeviceBinding(binding) : binding;
            // A valid device binding for i2c includes i2c:<busId>:<deviceId>.
            if (isNaN(bind.busId)) return Promise.reject(new Error(`setDeviceState: Invalid i2c bus id ${bind.busId} - ${bind.binding}`));
            let bus = this.buses.find(elem => elem.id === bind.busId);
            if (typeof bus === 'undefined') return Promise.reject(new Error(`setDeviceState: i2c bus not found ${bind.busId} - ${bind.binding}`));
            // At this point we know the protocol and we know the bus so forward this to our bus.
            return await bus.setDeviceState(bind, data);
        }
        catch (err) { return Promise.reject(err); }
    }
    public async feedDeviceValue(binding: string | DeviceBinding, data: any): Promise<any> {
        try {
            let bind = typeof binding === 'string' ? new DeviceBinding(binding) : binding;
            // A valid device binding for i2c includes i2c:<busId>:<deviceId>.
            if (isNaN(bind.busId)) return Promise.reject(new Error(`feedDeviceValue: Invalid i2c bus id ${bind.busId} - ${bind.binding}`));
            let bus = this.buses.find(elem => elem.id === bind.busId);
            if (typeof bus === 'undefined') return Promise.reject(new Error(`feedDeviceValue: i2c bus not found ${bind.busId} - ${bind.binding}`));
            // At this point we know the protocol and we know the bus so forward this to our bus.
            return await bus.feedDeviceValue(bind, data);
        }
        catch (err) { return Promise.reject(err); }
    }

    public async getDevice(binding: string | DeviceBinding): Promise<any> {
        try {
            let bind = typeof binding === 'string' ? new DeviceBinding(binding) : binding;
            // A valid device binding for i2c includes i2c:<busId>:<deviceId>.
            if (isNaN(bind.busId)) return Promise.reject(new Error(`getDevice: Invalid i2c bus id ${bind.busId} - ${bind.binding}`));
            let bus = this.buses.find(elem => elem.id === bind.busId);
            if (typeof bus === 'undefined') return Promise.reject(new Error(`getDevice: i2c bus not found ${bind.busId} - ${bind.binding}`));
            // At this point we know the protocol and we know the bus so forward this to our bus.
            return await bus.getDevice(bind);
        }
        catch (err) { return Promise.reject(err); }
    }
    public async getDeviceStatus(binding: string | DeviceBinding): Promise<any> {
        try {
            let bind = typeof binding === 'string' ? new DeviceBinding(binding) : binding;
            // A valid device binding for i2c includes i2c:<busId>:<deviceId>.
            if (isNaN(bind.busId)) return Promise.reject(new Error(`getDevice: Invalid i2c bus id ${bind.busId} - ${bind.binding}`));
            let bus = this.buses.find(elem => elem.id === bind.busId);
            if (typeof bus === 'undefined') return Promise.reject(new Error(`getDevice: i2c bus not found ${bind.busId} - ${bind.binding}`));
            // At this point we know the protocol and we know the bus so forward this to our bus.
            return await bus.getDeviceStatus(bind);
        }
        catch (err) { return Promise.reject(err); }
    }
    public async getDeviceState(binding: string | DeviceBinding): Promise<any> {
        try {
            let bind = typeof binding === 'string' ? new DeviceBinding(binding) : binding;
            // A valid device binding for i2c includes i2c:<busId>:<deviceId>.
            if (isNaN(bind.busId)) return Promise.reject(new Error(`getDeviceState: Invalid i2c bus id ${bind.busId} - ${bind.binding}`));
            let bus = this.buses.find(elem => elem.id === bind.busId);
            if (typeof bus === 'undefined') return Promise.reject(new Error(`getDeviceState: i2c bus not found ${bind.busId} - ${bind.binding}`));
            // At this point we know the protocol and we know the bus so forward this to our bus.
            return await bus.getDeviceState(bind);
        }
        catch (err) { return Promise.reject(err); }
    }
    public async resetDevice(dev): Promise<I2cDevice> {
        try {
            let busId = (typeof dev.busId !== 'undefined') ? parseInt(dev.busId, 10) : undefined;
            let busNumber = (typeof dev.busNumber !== 'undefined') ? parseInt(dev.busNumber, 10) : undefined;
            let bus: I2cBus;
            if (typeof busId !== 'undefined') {
                bus = this.buses.getItemById(busId);
                if (typeof bus.busNumber === 'undefined') return Promise.reject(new Error(`An invalid I2c bus id was supplied ${dev.busId}`));
            }
            else if (typeof busNumber !== 'undefined') {
                bus = this.buses.getItemByBusNumber(busNumber);
                if (typeof bus.id === 'undefined') return Promise.reject(new Error(`An invalid I2c bus # was supplied ${dev.busNumber}`));
            }
            else {
                return Promise.reject(new Error(`The specified I2c bus could not be found at busId:${dev.busId} or busNumber:${dev.busNumber}`));
            }
            let device = await bus.resetDevice(dev);
            return Promise.resolve(device);
        }
        catch (err) { return Promise.reject(err); }
    }
    public async changeAddress(dev): Promise<I2cDevice> {
        try {
            let busId = (typeof dev.busId !== 'undefined') ? parseInt(dev.busId, 10) : undefined;
            let busNumber = (typeof dev.busNumber !== 'undefined') ? parseInt(dev.busNumber, 10) : undefined;
            let bus: I2cBus;
            if (typeof busId !== 'undefined') {
                bus = this.buses.getItemById(busId);
                if (typeof bus.busNumber === 'undefined') return Promise.reject(new Error(`An invalid I2c bus id was supplied ${dev.busId}`));
            }
            else if (typeof busNumber !== 'undefined') {
                bus = this.buses.getItemByBusNumber(busNumber);
                if (typeof bus.id === 'undefined') return Promise.reject(new Error(`An invalid I2c bus # was supplied ${dev.busNumber}`));
            }
            else {
                return Promise.reject(new Error(`The specified I2c bus could not be found at busId:${dev.busId} or busNumber:${dev.busNumber}`));
            }
            let device = await bus.changeDeviceAddress(dev);
            return Promise.resolve(device);
        }
        catch (err) { return Promise.reject(err); }
    }

    public async setDevice(dev): Promise<I2cDevice> {
        try {
            let busId = (typeof dev.busId !== 'undefined') ? parseInt(dev.busId, 10) : undefined;
            let busNumber = (typeof dev.busNumber !== 'undefined') ? parseInt(dev.busNumber, 10) : undefined;
            let bus: I2cBus;
            if (typeof busId !== 'undefined') {
                bus = this.buses.getItemById(busId);
                if (typeof bus.busNumber === 'undefined') return Promise.reject(new Error(`An invalid I2c bus id was supplied ${dev.busId}`));
            }
            else if (typeof busNumber !== 'undefined') {
                bus = this.buses.getItemByBusNumber(busNumber);
                if (typeof bus.id === 'undefined') return Promise.reject(new Error(`An invalid I2c bus # was supplied ${dev.busNumber}`));
            }
            else {
                return Promise.reject(new Error(`The specified I2c bus could not be found at busId:${dev.busId} or busNumber:${dev.busNumber}`));
            }
            let device = await bus.setDevice(dev);
            return Promise.resolve(device);
        }
        catch (err) { return Promise.reject(err); }
    }
    public async runDeviceCommand(busNumber: number, address: number, command: string, options: any): Promise<any> {
        try {
            let dbus = i2c.buses.find(elem => elem.busNumber === busNumber);
            if (typeof dbus === 'undefined') return Promise.reject(`Cannot execute command Bus #${busNumber} could not be found`);
            let ddevice = dbus.devices.find(elem => elem.device.address === address);
            if (typeof ddevice === 'undefined') { return Promise.reject(`Cannot execute command Bus #${busNumber} Address ${address} could not be found`); }
            let result = await ddevice.callCommand({ name: command, params: [options] });
            return Promise.resolve(result);
        }
        catch (err) { return Promise.reject(err); }
    }
    public async deleteDevice(dev): Promise<I2cDevice> {
        try {
            let bus = (typeof dev.busId !== 'undefined') ? this.buses.getItemById(dev.busId) : typeof dev.busNumber !== 'undefined' ? this.buses.getItemByBusNumber(dev.busNumber) : undefined;
            if (typeof bus === 'undefined') return Promise.reject(`Could not find bus by bus #${dev.busNumber} or id ${dev.busId}`);
            let device = await bus.deleteDevice(dev);
            return Promise.resolve(device);
        }
        catch (err) { return Promise.reject(err); }
    }
    public async deleteBus(bus): Promise<I2cBus> {
        try {
            let b = (typeof bus.Id !== 'undefined') ? this.buses.getItemById(bus.id) : typeof bus.busNumber !== 'undefined' ? this.buses.getItemByBusNumber(bus.busNumber) : undefined;
            if (typeof b === 'undefined') return Promise.reject(`Could not find bus by bus #${bus.busNumber} or id ${bus.busId}`);
            await b.closeAsync();
            this.buses.removeItemById(b.id);
            return Promise.resolve(bus);
        }
        catch (err) { return Promise.reject(err); }
    }
    public getDeviceInputs(): any[] {
        let devices = [];
        for (let i = 0; i < this.buses.length; i++) {
            let bus = this.buses.getItemByIndex(i);
            devices.push(...bus.getDeviceInputs());
        }
        return devices;
    }
    public getDeviceById(busId: number, deviceId: number):I2cDevice {
        let bus = this.buses.getItemById(busId);
        return bus.getDeviceById(deviceId);
    }
    public async setDeviceFeed(data): Promise<DeviceFeedCollection> {
        if (typeof data.busNumber === 'undefined' && typeof data.busId === 'undefined') return Promise.reject(new Error(`A valid i2c bus identifier was not provided`));
        try {
            let busId;
            let busNumber;
            let bus;
            if (typeof data.busId !== 'undefined') {
                busId = parseInt(data.busId, 10);
                if (isNaN(busId)) return Promise.reject(new Error(`A valid i2c bus id was not provided ${data.busId}`));
            }
            if (typeof data.busNumber !== 'undefined') {
                busNumber = parseInt(data.busNumber, 10);
                if (isNaN(busNumber)) return Promise.reject(new Error(`A valid i2c bus # was not provided ${data.busNumber}`));
            }
            if (!isNaN(busId)) bus = this.buses.getItemById(busId);
            else if (!isNaN(busNumber)) bus = this.buses.getItemByBusNumber(busNumber);
            else return Promise.reject(new Error(`A valid i2c bus identifier was not provided`));
            return await bus.setDeviceFeed(data);
        }
        catch (err) { return Promise.reject(err); }
    }
    public async deleteDeviceFeed(data): Promise<DeviceFeedCollection> {
        if (typeof data.busNumber === 'undefined' && typeof data.busId === 'undefined') return Promise.reject(new Error(`A valid i2c bus identifier was not provided`));
        try {
            let busId;
            let busNumber;
            let bus;
            if (typeof data.busId !== 'undefined') {
                busId = parseInt(data.busId, 10);
                if (isNaN(busId)) return Promise.reject(new Error(`A valid i2c bus id was not provided ${data.busId}`));
            }
            if (typeof data.busNumber !== 'undefined') {
                busNumber = parseInt(data.busNumber, 10);
                if (isNaN(busNumber)) return Promise.reject(new Error(`A valid i2c bus # was not provided ${data.busNumber}`));
            }
            if (!isNaN(busId)) bus = this.buses.getItemById(busId);
            else if (!isNaN(busNumber)) bus = this.buses.getItemByBusNumber(busNumber);
            else return Promise.reject(new Error(`A valid i2c bus identifier was not provided`));
            return await bus.deleteDeviceFeed(data);
        }
        catch (err) { return Promise.reject(err); }
    }
    public async setDeviceTrigger(data): Promise<DeviceTriggerCollection> {
        if (typeof data.busNumber === 'undefined' && typeof data.busId === 'undefined') return Promise.reject(new Error(`A valid i2c bus identifier was not provided`));
        try {
            let busId;
            let busNumber;
            let bus: I2cBus;
            if (typeof data.busId !== 'undefined') {
                busId = parseInt(data.busId, 10);
                if (isNaN(busId)) return Promise.reject(new Error(`A valid i2c bus id was not provided ${data.busId}`));
            }
            if (typeof data.busNumber !== 'undefined') {
                busNumber = parseInt(data.busNumber, 10);
                if (isNaN(busNumber)) return Promise.reject(new Error(`A valid i2c bus # was not provided ${data.busNumber}`));
            }
            if (!isNaN(busId)) bus = this.buses.getItemById(busId);
            else if (!isNaN(busNumber)) bus = this.buses.getItemByBusNumber(busNumber);
            else return Promise.reject(new Error(`A valid i2c bus identifier was not provided`));
            return await bus.setDeviceTrigger(data);
        }
        catch (err) { return Promise.reject(err); }
    }
    public async deleteDeviceTrigger(data): Promise<DeviceTriggerCollection> {
        if (typeof data.busNumber === 'undefined' && typeof data.busId === 'undefined') return Promise.reject(new Error(`A valid i2c bus identifier was not provided`));
        try {
            let busId;
            let busNumber;
            let bus: I2cBus;
            if (typeof data.busId !== 'undefined') {
                busId = parseInt(data.busId, 10);
                if (isNaN(busId)) return Promise.reject(new Error(`A valid i2c bus id was not provided ${data.busId}`));
            }
            if (typeof data.busNumber !== 'undefined') {
                busNumber = parseInt(data.busNumber, 10);
                if (isNaN(busNumber)) return Promise.reject(new Error(`A valid i2c bus # was not provided ${data.busNumber}`));
            }
            if (!isNaN(busId)) bus = this.buses.getItemById(busId);
            else if (!isNaN(busNumber)) bus = this.buses.getItemByBusNumber(busNumber);
            else return Promise.reject(new Error(`A valid i2c bus identifier was not provided`));
            return await bus.deleteDeviceTrigger(data);
        }
        catch (err) { return Promise.reject(err); }
    }

}
export class I2cBusCollection extends ConfigItemCollection<I2cBus> {
    constructor(data: any, name?: string) { super(data, name) }
    public createItem(data: any): I2cBus { return new I2cBus(data); }
    public getItemByBusNumber(busNumber: number | string, add?: boolean, data?: any): I2cBus {
        let itm = this.find(elem => elem.busNumber === busNumber && typeof elem.busNumber !== 'undefined');
        if (typeof itm !== 'undefined') return itm;
        let id = this.getMaxId() + 1 || 1;
        if (typeof add !== 'undefined' && add) return this.add(data || { id: id, busNumber: busNumber });
        return this.createItem(data || { id: id, busNumber: busNumber });
    }
}

export class I2cBus extends ConfigItem {
    public initData(data?: any) {
        if (typeof this.data.isActive === 'undefined') this.isActive = true;
        if (typeof this.data.devices === 'undefined') this.data.devices = [];
        return data;
    }
    public get id(): number { return this.data.id; }
    public set id(val: number) { this.setDataVal('id', val); }
    public get busNumber(): number { return this.data.busNumber; }
    public set busNumber(val: number) { this.setDataVal('busNumber', val); }
    public get isActive(): boolean { return utils.makeBool(this.data.isActive); }
    public set isActive(val: boolean) { this.setDataVal('isActive', val); }
    public get addresses(): { address: number, name: string, product: number, manufacturer: number }[] { return this.data.addresses || []; }
    public set addresses(val: { address: number, name: string, product: number, manufacturer: number }[]) { this.setDataVal('addresses', val); }
    public get functions(): any { return this.data.functions || {}; }
    public set functions(val: any) { this.setDataVal('functions', val); }
    public get devices(): I2cDeviceCollection { return new I2cDeviceCollection(this.data, 'devices'); }
    public getExtended() {
        let c = this.get(true);
        c.detected = cont.i2c.detected.find(elem => elem.busNumber === this.busNumber);
        c.devices = [];
        for (let i = 0; i < this.devices.length; i++) {
            c.devices.push(this.devices.getItemByIndex(i).getExtended());
        }
        return c;
    }
    public async closeAsync(): Promise<void> {
        try {
            let dbus = i2c.buses.find(elem => elem.busNumber === this.busNumber);
            if (typeof dbus !== 'undefined') {
                await dbus.closeAsync();
            }
            return Promise.resolve();
        }
        catch (err) { return Promise.reject(err); }
    }
    public async scanBus() {
        try {
            let dbus = i2c.buses.find(elem => elem.busNumber === this.busNumber);
            if(typeof dbus !== 'undefined') this.addresses = await dbus.scanBus();
        } catch (err) { return Promise.reject(err); }
    }
    public async addAddress(obj) {
        try {
            let dbus = i2c.buses.find(elem => elem.busNumber === this.busNumber);
            if (typeof dbus === 'undefined') return Promise.reject(`Cannot add address bus ${this.id} is not initialized.`);
            let addr = parseInt(obj.newAddress, 10);
            if (isNaN(addr)) return Promise.reject(new Error(`Cannot add invalid address ${obj.newAddress}`));
            let cdev = this.addresses.find(elem => elem.address === addr);
            if (typeof cdev !== 'undefined') return Promise.reject(`Address ${cdev.address} aready exists for device ${cdev.name}`);
            this.addresses.push({ address: addr, name: 'Unknown', product: 0, manufacturer: 0 });
            this.addresses.sort((a, b) => { return a.address - b.address });
        } catch (err) { return Promise.reject(err); }
    }
    public async setDeviceState(binding: string | DeviceBinding, data: any): Promise<any> {
        try {
            logger.info(`Setting device state ${binding}`);
            let bind = typeof binding === 'string' ? new DeviceBinding(binding) : binding;
            if (isNaN(bind.deviceId)) return Promise.reject(`setDeviceState: Invalid i2c deviceId ${bind.busId} ${bind.deviceId} - ${bind.binding}`);
            let device = this.devices.find(elem => elem.id === bind.deviceId);
            if (typeof device === 'undefined') return Promise.reject(`setDeviceState: Could not find i2c device ${bind.busId}:${bind.deviceId} - ${bind.binding}`);
            return await device.setDeviceState(bind, data);
        } catch (err) { return Promise.reject(err); }
    }
    public async feedDeviceValue(binding: string | DeviceBinding, data: any): Promise<any> {
        try {
            let bind = typeof binding === 'string' ? new DeviceBinding(binding) : binding;
            if (isNaN(bind.deviceId)) return Promise.reject(new Error(`feedDeviceValue: Invalid i2c deviceId ${bind.busId} ${bind.deviceId} - ${bind.binding}`));
            let device = this.devices.find(elem => elem.id === bind.deviceId);
            if (typeof device === 'undefined') return Promise.reject(new Error(`feedDeviceValue: Could not find i2c device ${bind.busId}:${bind.deviceId} - ${bind.binding}`));
            return await device.feedDeviceValue(bind, data);
        } catch (err) { return Promise.reject(err); }
    }
    public async getDevice(binding: string | DeviceBinding): Promise<any> {
        try {
            let bind = typeof binding === 'string' ? new DeviceBinding(binding) : binding;
            if (isNaN(bind.deviceId)) return Promise.reject(new Error(`getDevice: Invalid i2c deviceId ${bind.busId} ${bind.deviceId} - ${bind.binding}`));
            let device = this.devices.find(elem => elem.id === bind.deviceId);
            if (typeof device === 'undefined') return Promise.reject(new Error(`getDevice: Could not find i2c device ${bind.busId}:${bind.deviceId} - ${bind.binding}`));
            return device;
        } catch (err) { return Promise.reject(err); }
    }

    public async getDeviceStatus(binding: string | DeviceBinding): Promise<any> {
        try {
            let bind = typeof binding === 'string' ? new DeviceBinding(binding) : binding;
            if (isNaN(bind.deviceId)) return Promise.reject(new Error(`getDeviceStatus: Invalid i2c deviceId ${bind.busId} ${bind.deviceId} - ${bind.binding}`));
            let device = this.devices.find(elem => elem.id === bind.deviceId);
            if (typeof device === 'undefined') return Promise.reject(new Error(`getDeviceStatus: Could not find i2c device ${bind.busId}:${bind.deviceId} - ${bind.binding}`));
            let bus = i2c.buses.find(elem => this.busNumber === elem.busNumber);
            if (typeof bus === 'undefined') return Promise.reject(new Error(`getDeviceStatus: Bus not initialized ${bind.busId} ${bind.deviceId} - ${bind.binding}`));
            let dev = bus.devices.find(elem => elem.device.id === bind.deviceId);
            if (typeof dev === 'undefined') return Promise.reject(new Error(`getDeviceStatus: Device not initialized ${bind.busId} ${bind.deviceId} - ${bind.binding}`));
            return dev.deviceStatus;
        } catch (err) { return Promise.reject(err); }
    }
    public async getDeviceState(binding: string | DeviceBinding): Promise<any> {
        try {
            let bind = typeof binding === 'string' ? new DeviceBinding(binding) : binding;
            if (isNaN(bind.deviceId)) return Promise.reject(new Error(`getDeviceState: Invalid i2c deviceId ${bind.busId} ${bind.deviceId} - ${bind.binding}`));
            let device = this.devices.find(elem => elem.id === bind.deviceId);
            if (typeof device === 'undefined') return Promise.reject(new Error(`getDeviceState: Could not find i2c device ${bind.busId}:${bind.deviceId} - ${bind.binding}`));
            let bus = i2c.buses.find(elem => this.busNumber === elem.busNumber);
            if (typeof bus === 'undefined') return Promise.reject(new Error(`getDeviceState: Bus not initialized ${bind.busId} ${bind.deviceId} - ${bind.binding}`));
            let dev = bus.devices.find(elem => elem.device.id === bind.deviceId);
            if (typeof dev === 'undefined') return Promise.reject(new Error(`getDeviceState: Device not initialized ${bind.busId} ${bind.deviceId} - ${bind.binding}`));
            return { status: dev.deviceStatus, state: await dev.getDeviceState(bind) };
        } catch (err) { return Promise.reject(err); }
    }

    public async setDevice(dev): Promise<I2cDevice> {
        try {
            let id = typeof dev.id !== 'undefined' && dev.id ? parseInt(dev.id, 10) : undefined;
            let address = typeof dev.address !== 'undefined' ? parseInt(dev.address, 10) : undefined;
            let typeId = typeof dev.typeId !== 'undefined' ? parseInt(dev.typeId, 10) : undefined;
            let device: I2cDevice;
            let added = false;
            if (typeof id === 'undefined') {
                // We are adding a device.
                if (typeof address === 'undefined' || isNaN(address) || address < 1) return Promise.reject(new Error(`An valid I2c device address was not supplied ${dev.address}`));
                if (typeof typeId === 'undefined' || isNaN(typeId)) return Promise.reject(new Error(`An invalid device type id was supplied ${dev.typeId}`));
                if (typeof this.devices.find(elem => elem.address === address) !== 'undefined') return Promise.reject(`A device already exists at thes specified address ${address}`);
                id = this.devices.getMaxId() + 1 || 1;
                device = this.devices.getItemById(id, true);
                device.address = address;
                device.typeId = typeId;
                device.options = dev.options || {};
                added = true;
            }
            else {
                if (typeof typeId !== 'undefined') { if (isNaN(typeId)) return Promise.reject(new Error(`An invalid deviceTypeId was supplied ${dev.deviceTypeId}`)); }
                if (typeof address !== 'undefined') {
                    if (isNaN(address) || address < 0) return Promise.reject(new Error(`An invalid I2c address was supplied ${dev.address}`));
                    if (typeof this.devices.find(elem => elem.address === address && elem.id !== id) !== 'undefined') return Promise.reject(`A device already exists at thes specified address ${address}`);
                }
                if (typeof id !== 'undefined') {
                    if (isNaN(id)) return Promise.reject(new Error(`An invalid device id was supplied ${dev.id}`));
                    device = this.devices.getItemById(id);
                }
                else if (typeof address !== 'undefined') {
                    device = this.devices.getItemByAddress(address);
                }
            }
            // At this point we should have our device.
            if (typeof dev.typeId !== 'undefined' && typeId !== device.typeId) {
                // If the type has changed clear out the options;
                device.typeId = typeId;
                device.options = {};
            }
            if (typeof dev.address !== 'undefined' && address !== device.address) device.address = address;
            if (typeof dev.sampling !== 'undefined' && !isNaN(parseInt(dev.sampling, 10))) device.sampling = parseInt(dev.sampling, 10);
            if (typeof dev.isActive !== 'undefined') device.isActive = utils.makeBool(dev.isActive);
            // Need to deal with the triggers and feeds.
            //if (typeof dev.options !== 'undefined') {
            //    let op = Object.getOwnPropertyNames(dev.options);
            //    for (let i in op) {
            //        let prop = op[i];
            //        if (typeof this[prop] === 'function') continue;
            //        if (typeof dev.options[prop] !== 'undefined') {
            //            device.options[prop] = dev.options[prop];
            //        }
            //    }
            //}
            let dbus = i2c.buses.find(elem => elem.busNumber === this.busNumber);
            if (typeof dbus !== 'undefined') {
                let ddev = dbus.devices.find(elem => elem.device.id === device.id);
                if (typeof ddev === 'undefined') {
                    await dbus.addDevice(device);
                }
                else {
                    if (typeof dev.options !== 'undefined') await ddev.setOptions(dev.options);
                    if (typeof dev.values !== 'undefined') await ddev.setValues(dev.values);
                }
            }
            let addr = this.addresses.find(elem => elem.address === device.address);
            if (typeof addr !== 'undefined') addr.name = device.name;
            return Promise.resolve(device);
        }
        catch (err) { return Promise.reject(err); }
    }
    public async resetDevice(dev): Promise<I2cDevice> {
        try {
            let id = typeof dev.id !== 'undefined' && dev.id ? parseInt(dev.id, 10) : undefined;
            let address = typeof dev.address !== 'undefined' ? parseInt(dev.address, 10) : undefined;
            let typeId = typeof dev.typeId !== 'undefined' ? parseInt(dev.typeId, 10) : undefined;
            let device: I2cDevice;
            let added = false;
            if (typeof id === 'undefined') {
                // We are adding a device.
                if (typeof address === 'undefined' || isNaN(address) || address < 1) return Promise.reject(new Error(`An valid I2c device address was not supplied ${dev.address}`));
                if (typeof typeId === 'undefined' || isNaN(typeId)) return Promise.reject(new Error(`An invalid device type id was supplied ${dev.typeId}`));
                if (typeof this.devices.find(elem => elem.address === address) !== 'undefined') return Promise.reject(`A device already exists at thes specified address ${address}`);
                id = this.devices.getMaxId() + 1 || 1;
                device = this.devices.getItemById(id, true);
                device.address = address;
                device.typeId = typeId;
                device.options = dev.options || {};
                added = true;
            }
            else {
                if (typeof typeId !== 'undefined') { if (isNaN(typeId)) return Promise.reject(new Error(`An invalid deviceTypeId was supplied ${dev.deviceTypeId}`)); }
                if (typeof address !== 'undefined') {
                    if (isNaN(address) || address < 0) return Promise.reject(new Error(`An invalid I2c address was supplied ${dev.address}`));
                    if (typeof this.devices.find(elem => elem.address === address && elem.id !== id) !== 'undefined') return Promise.reject(`A device already exists at thes specified address ${address}`);
                }
                if (typeof id !== 'undefined') {
                    if (isNaN(id)) return Promise.reject(new Error(`An invalid device id was supplied ${dev.id}`));
                    device = this.devices.getItemById(id);
                }
                else if (typeof address !== 'undefined') {
                    device = this.devices.getItemByAddress(address);
                }
            }
            // At this point we should have our device.
            if (typeof dev.typeId !== 'undefined' && typeId !== device.typeId) {
                // If the type has changed clear out the options;
                device.typeId = typeId;
                device.options = {};
            }
            if (typeof dev.address !== 'undefined' && address !== device.address) device.address = address;
            if (typeof dev.sampling !== 'undefined' && !isNaN(parseInt(dev.sampling, 10))) device.sampling = parseInt(dev.sampling, 10);
            if (typeof dev.isActive !== 'undefined') device.isActive = utils.makeBool(dev.isActive);
            // Need to deal with the triggers and feeds.
            //if (typeof dev.options !== 'undefined') {
            //    let op = Object.getOwnPropertyNames(dev.options);
            //    for (let i in op) {
            //        let prop = op[i];
            //        if (typeof this[prop] === 'function') continue;
            //        if (typeof dev.options[prop] !== 'undefined') {
            //            device.options[prop] = dev.options[prop];
            //        }
            //    }
            //}
            let dbus = i2c.buses.find(elem => elem.busNumber === this.busNumber);
            if (typeof dbus !== 'undefined') {
                let ddev = dbus.devices.find(elem => elem.device.id === device.id);
                if (typeof ddev === 'undefined') {
                    return Promise.reject(new Error(`The I2c device at ${dev.address} could not be found on the bus.`));
                }
                else
                    await ddev.resetDevice(dev);
            }
            let addr = this.addresses.find(elem => elem.address === device.address);
            if (typeof addr !== 'undefined') addr.name = device.name;
            return Promise.resolve(device);
        }
        catch (err) { return Promise.reject(err); }
    }
    public async changeDeviceAddress(dev): Promise<I2cDevice> {
        try {
            let id = typeof dev.id !== 'undefined' && dev.id ? parseInt(dev.id, 10) : undefined;
            let newAddress = typeof dev.newAddress !== 'undefined' ? parseInt(dev.newAddress, 10) : undefined;
            let dbus = i2c.buses.find(elem => elem.busNumber === this.busNumber);
            let ddev;
            let device: I2cDevice;
            if (typeof newAddress === 'undefined' || newAddress < 1 || newAddress > 127 || isNaN(newAddress)) return Promise.reject(new Error(`A valid new address was not supplied. ${dev.newAddress}`));
            if (typeof id === 'undefined') {
                // You cannot change the address of a device we have not added or are not in control of.
                return Promise.reject(new Error(`You may not change the address of a device that has not been added ${dev.address}`));
            }
            else {
                device = this.devices.getItemById(id);
                if (typeof dbus !== 'undefined') {
                    ddev = dbus.devices.find(elem => elem.device.id === id);
                    if (typeof ddev === 'undefined') {
                        return Promise.reject(new Error(`The I2c device id ${id} could not be found on the bus.`));
                    }
                }
                else
                    return Promise.reject(new Error(`The I2c bus at ${this.busNumber} could not be found.`));

                let address = device.address;
                if (isNaN(address) || address < 0) return Promise.reject(new Error(`An invalid I2c address was supplied ${dev.address}`));
                if (typeof this.devices.find(elem => elem.address === address && elem.id !== id) !== 'undefined') return Promise.reject(`A device already exists at this specified address ${address}`);
                // Check to see if there is another address at the new address.
                if (typeof this.devices.find(elem => elem.address === newAddress && elem.id !== id) !== 'undefined') return Promise.reject(`A device already exists at the new specified address ${newAddress}`);
                if (typeof ddev.changeAddress !== 'function') return Promise.reject(`This device does not support changing the address via software`);
                await ddev.changeAddress(newAddress);
                // Remove the old address and add in the new one.
                await this.scanBus();
            }
            return device;
        }
        catch (err) { logger.error(err.message); return Promise.reject(err); }
    }

    public async deleteDevice(dev): Promise<I2cDevice> {
        try {
            let id = parseInt(dev.id, 10);
            if (isNaN(id)) return Promise.reject(`Cannot delete device. Invalid device id ${dev.id}`);
            let dbus = i2c.buses.find(elem => elem.busNumber == this.busNumber);
            if (typeof dbus !== 'undefined') {
                dbus.devices.forEach(async (item, index) => {
                    if (item.device.id === id) {
                        dbus.devices.splice(index, 1);
                        await item.closeAsync();
                    }
                });
            }
            let device = this.devices.getItemById(id);
            this.devices.removeItemById(id);
            let addr = this.addresses.find(elem => elem.address === device.address);
            if (typeof addr !== 'undefined') addr.name = 'Unknown';
            return Promise.resolve(device);
        }
        catch (err) { return Promise.reject(err); }
    }
    public getDeviceInputs(): any[] {
        let devices = [];
        let ad = cont.analogDevices;
        for (let i = 0; i < this.devices.length; i++) {
            let device = this.devices.getItemByIndex(i);
            let dev;
            if (typeof device.typeId !== 'undefined' && device.typeId !== 0)
                dev = ad.find(elem => elem.id === device.typeId);
            if (typeof dev !== 'undefined' && typeof dev.inputs !== 'undefined') {
                devices.push({ uid: `i2c:${this.busNumber}:${device.id}`, id: device.id, name: device.name, deviceId: dev.id, type: 'i2c', busNumber: this.busNumber, bindings: dev.inputs });
            }
        }
        return devices;
    }
    public async setDeviceFeed(data): Promise<DeviceFeedCollection> {
        try {
            if (typeof data.deviceId === 'undefined' && data.address === 'undefined') return Promise.reject(new Error(`Feed device address or id was not provided.`));
            let devId = (typeof data.deviceId !== 'undefined') ? parseInt(data.deviceId, 10) : undefined;
            let address = (typeof data.address !== 'undefined') ? parseInt(data.address, 10) : undefined;
            let dev = !isNaN(devId) ? this.devices.getItemById(devId) : this.devices.getItemByAddress(address);
            if (isNaN(dev.typeId)) return Promise.reject(new Error(`Feed device has not been initialized`));
            await dev.setDeviceFeed(data);
            i2c.resetDeviceFeeds(this.id, dev.id);
            return Promise.resolve(dev.feeds);
        }
        catch (err) { return Promise.reject(err); }
    }
    public async deleteDeviceFeed(data): Promise<DeviceFeedCollection> {
        try {
            if (typeof data.deviceId === 'undefined' && data.address === 'undefined') return Promise.reject(new Error(`Feed device address or id was not provided.`));
            let devId = (typeof data.deviceId !== 'undefined') ? parseInt(data.deviceId, 10) : undefined;
            let address = (typeof data.address !== 'undefined') ? parseInt(data.address, 10) : undefined;
            let dev = !isNaN(devId) ? this.devices.getItemById(devId) : this.devices.getItemByAddress(address);
            if (isNaN(dev.typeId)) return Promise.reject(new Error(`Feed device has not been initialized`));
            await dev.deleteDeviceFeed(data);
            i2c.resetDeviceFeeds(this.id, dev.id);
            return Promise.resolve(dev.feeds);
        }
        catch (err) { return Promise.reject(err); }
    }
    public async setDeviceTrigger(data): Promise<DeviceTriggerCollection> {
        try {
            if (typeof data.deviceId === 'undefined' && data.address === 'undefined') return Promise.reject(new Error(`Trigger device address or id was not provided.`));
            let devId = (typeof data.deviceId !== 'undefined') ? parseInt(data.deviceId, 10) : undefined;
            let address = (typeof data.address !== 'undefined') ? parseInt(data.address, 10) : undefined;
            let dev: I2cDevice = !isNaN(devId) ? this.devices.getItemById(devId) : this.devices.getItemByAddress(address);
            if (isNaN(dev.typeId)) return Promise.reject(new Error(`Trigger device has not been initialized`));
            await dev.setDeviceTrigger(data);
            i2c.resetDeviceTriggers(this.id, dev.id);
            return Promise.resolve(dev.triggers);
        }
        catch (err) { return Promise.reject(err); }
    }
    public async deleteDeviceTrigger(data): Promise<DeviceTriggerCollection> {
        try {
            if (typeof data.deviceId === 'undefined' && data.address === 'undefined') return Promise.reject(new Error(`Trigger device address or id was not provided.`));
            let devId = (typeof data.deviceId !== 'undefined') ? parseInt(data.deviceId, 10) : undefined;
            let address = (typeof data.address !== 'undefined') ? parseInt(data.address, 10) : undefined;
            let dev: I2cDevice = !isNaN(devId) ? this.devices.getItemById(devId) : this.devices.getItemByAddress(address);
            if (isNaN(dev.typeId)) return Promise.reject(new Error(`Trigger device has not been initialized`));
            await dev.deleteDeviceTrigger(data);
            i2c.resetDeviceTriggers(this.id, dev.id);
            return Promise.resolve(dev.triggers);
        }
        catch (err) { return Promise.reject(err); }
    }

    public getDeviceById(deviceId: number) { return this.devices.getItemById(deviceId); }
    //public async setDeviceTriggerAsync(deviceId: number, data): Promise<DeviceTrigger> {
    //    let dev = this.devices.getItemById(deviceId, true);
    //    return await dev.setDeviceTriggerAsync(data);
    //}
    //public async deleteDeviceTriggerAsync(deviceId: number, data): Promise<I2cDevice> {
    //    return await this.devices.getItemById(deviceId, false).deleteDeviceTriggerAsync(data);
    //}
}
export class I2cDeviceCollection extends ConfigItemCollection<I2cDevice> {
    constructor(data: any, name?: string) { super(data, name || 'devices') }
    public createItem(data: any): I2cDevice { return new I2cDevice(data); }
    public getItemByAddress(address: number | string, add?: boolean, data?: any): I2cDevice {
        let itm = this.find(elem => elem.address === address && typeof elem.address !== 'undefined');
        if (typeof itm !== 'undefined') return itm;
        let id = this.getMaxId() + 1 || 1;
        if (typeof add !== 'undefined' && add) return this.add(data || { id: id, address: address });
        return this.createItem(data || { address: address });
    }
}
export class I2cDevice extends ConfigItem {
    constructor(data) { super(data); }
    public initData(data?: any) {
        if (typeof this.data.values === 'undefined') this.values = {};
        if (typeof this.data.options === 'undefined') this.options = {};
        if (typeof this.data.info === 'undefined') this.info = {};
        return data;
    }
    public get id(): number { return this.data.id; }
    public set id(val: number) { this.setDataVal('id', val); }
    public get name(): string { return this.data.name; }
    public set name(val: string) { this.setDataVal('name', val); }
    public get isActive(): boolean { return utils.makeBool(this.data.isActive); }
    public set isActive(val: boolean) { this.setDataVal('isActive', val); }
    public get typeId(): number { return this.data.typeId; }
    public set typeId(val: number) { this.setDataVal('typeId', val); }
    public get address(): number { return this.data.address; }
    public set address(val: number) { this.setDataVal('address', val); }
    public get feeds(): DeviceFeedCollection { return new DeviceFeedCollection(this.data, 'feeds'); }
    public get triggers(): DeviceTriggerCollection { return new DeviceTriggerCollection(this.data, 'triggers'); }
    public get options(): any { return typeof this.data.options === 'undefined' ? this.data.options = {} : this.data.options; }
    public set options(val: any) { this.setDataVal('options', val || {}); }
    public get info(): any { return typeof this.data.info === 'undefined' ? this.data.info = {} : this.data.info; }
    public set info(val: any) { this.setDataVal('info', val || {}); }
    public get values(): any { return typeof this.data.values === 'undefined' ? this.data.values = {} : this.data.values; }
    public set values(val: any) { this.setDataVal('values', val || {}); }
    public get sampling(): number { return this.data.sampling; }
    public set sampling(val: number) { this.setDataVal('sampling', val); }
    public getExtended() {
        let dev = this.get(true);
        dev.deviceType = cont.analogDevices.find(elem => elem.id === this.typeId);
        dev.feeds = [];
        for (let i = 0; i < this.feeds.length; i++) {
            dev.feeds.push(this.feeds.getItemByIndex(i).getExtended());
        }
        dev.triggers = [];
        for (let i = 0; i < this.triggers.length; i++) {
            dev.triggers.push(this.triggers.getItemByIndex(i).getExtended());
        }
        return dev;
    }
    public getDeviceType() {
        return cont.analogDevices.find(elem => elem.id === this.typeId);
    }
    public async setDeviceFeed(data): Promise<DeviceFeed> {
        try {
            let feedId = typeof data.id !== 'undefined' ? parseInt(data.id, 10) : typeof data.feedId !== 'undefined' ? parseInt(data.feedId, 10) : -1;
            if (isNaN(feedId)) return Promise.reject(`The feed identifier is not valid.`);
            let feed: DeviceFeed;
            let connectionId;
            let connection;
            // search for existing feed; also acts as to not allow duplicate feeds
            feed = this.getDeviceFeed(data); // try to find feed with matching data; useful if data is sent from njsPC
            if (typeof feed !== 'undefined') {
                connectionId = feed.connectionId
            }
            else if (feedId !== -1) {
                // We are updating.
                feed = this.feeds.find(elem => elem.id === feedId);
                if (typeof feed === 'undefined') return Promise.reject(`Could not find a feed by id ${feedId}`);
                connectionId = feed.connectionId;
            }
            else {
                // We are adding.
                feedId = (this.feeds.getMaxId() || 0) + 1;
                connectionId = parseInt(data.connectionId, 10);
                if (isNaN(connectionId)) return Promise.reject(new Error(`The feed connection identifier was not supplied.`));
            }
            connection = connectionId !== -1 ? cont.connections.find(elem => elem.id === connectionId) : undefined;
            if (connectionId !== -1 && typeof connection === 'undefined') return Promise.reject(`The feed connection was not found at id ${connectionId}`);
            if (typeof feed === 'undefined') feed = this.feeds.getItemById(feedId, true);
            feed.connectionId = connectionId;
            feed.set(data);
            feed.id = feedId;
            // Set this on the bus.
            return Promise.resolve(feed);
        }
        catch (err) { return Promise.reject(err); }
    }
    public async deleteDeviceFeed(data): Promise<DeviceFeed> {
        try {
            let feedId = typeof data.id !== 'undefined' ? parseInt(data.id, 10) : typeof data.feedId !== 'undefined' ? parseInt(data.feedId, 10) : -1;
            if (isNaN(feedId)) return Promise.reject(`The feed identifier is not valid.`);
            let feed: DeviceFeed;
            let connectionId;
            let connection;
            feed = this.feeds.getItemById(feedId);
            this.feeds.removeItemById(feedId);
            return Promise.resolve(feed);
        }
        catch (err) { return Promise.reject(err); }
    }
    public getDeviceFeed(data): DeviceFeed {
        try {
            let feedId = typeof data.id !== 'undefined' ? parseInt(data.id, 10) : typeof data.feedId !== 'undefined' ? parseInt(data.feedId, 10) : -1;
            if (isNaN(feedId)) return;
            let feed: DeviceFeed;
            if (feedId !== -1) {
                // Search by feed id
                return this.feeds.find(elem => elem.id === feedId);
            }
            else {
                // Search by attributes
                for (let i = 0; i < this.feeds.length; i++) {
                    feed = this.feeds.getItemByIndex(i);
                    if (feed.options.id === data.options.id &&
                        feed.sendValue === data.sendValue &&
                        (feed.eventName === data.eventName) &&
                        feed.property === data.property) {
                        return feed; // what if multiple matching(?)
                    }
                }
            }
        }
        catch (err) { logger.error(`getDeviceFeed GPIO: ${err};`); }
    }
    public async setDeviceTrigger(data): Promise<DeviceTrigger> {
        try {
            let triggerId = typeof data.id !== 'undefined' ? parseInt(data.id, 10) : typeof data.triggerId !== 'undefined' ? parseInt(data.triggerId, 10) : -1;
            if (isNaN(triggerId)) return Promise.reject(`The trigger identifier is not valid.`);
            let trigger : DeviceTrigger;
            let connectionId;
            let connection;
            if (triggerId !== -1) {
                // We are updating.
                trigger = this.triggers.find(elem => elem.id === triggerId);
                if (typeof trigger === 'undefined') return Promise.reject(`Could not find a trigger by id ${triggerId}`);
                connectionId = trigger.sourceId;
            }
            else {
                // We are adding.
                triggerId = (this.triggers.getMaxId() || 0) + 1;
                connectionId = parseInt(data.sourceId, 10);
                if (isNaN(connectionId)) return Promise.reject(new Error(`The trigger connection identifier was not supplied.`));
            }
            connection = connectionId !== -1 ? cont.connections.find(elem => elem.id === connectionId) : undefined;
            if (connectionId !== -1 && typeof connection === 'undefined') return Promise.reject(`The trigger connection was not found at id ${connectionId}`);
            trigger = this.triggers.getItemById(triggerId, true);
            trigger.sourceId = connectionId;
            trigger.set(data);
            trigger.id = triggerId;
            // Set this on the bus.
            return Promise.resolve(trigger);
        }
        catch (err) { return Promise.reject(err); }
    }
    public async deleteDeviceTrigger(data): Promise<DeviceTrigger> {
        try {
            let triggerId = typeof data.id !== 'undefined' ? parseInt(data.id, 10) : typeof data.triggerId !== 'undefined' ? parseInt(data.triggerId, 10) : -1;
            if (isNaN(triggerId)) return Promise.reject(`The trigger identifier is not valid.`);
            let trigger: DeviceTrigger;
            trigger = this.triggers.getItemById(triggerId);
            this.triggers.removeItemById(triggerId);
            return trigger;
        }
        catch (err) { return Promise.reject(err); }
    }

    //public async deleteDeviceTriggerAsync(triggerId: number): Promise<I2cDevice> {
    //    return new Promise<I2cDevice>((resolve, reject) => {
    //        this.triggers.removeItemById(triggerId);
    //        resolve(this);
    //    });
    //}
    //public async setDeviceTriggerAsync(data): Promise<DeviceTrigger> {
    //    let c = this.triggers.find(elem => elem.id === data.id);
    //    if (typeof c === 'undefined') {
    //        data.id = this.triggers.getMaxId(false, -1) + 1;
    //        if (data.id === 0) data.id = 1;
    //        c = this.triggers.getItemById(data.id, true);
    //    }
    //    return await c.setDeviceTriggerAsync(data);
    //}

    public async setDeviceState(binding: string | DeviceBinding, data: any) {
        try {
            let bind = typeof binding === 'string' ? new DeviceBinding(binding) : binding;
            if (this.isActive === false) return Promise.reject(new Error(`setDeviceState: i2c Device ${this.name} not active - ${bind.binding}`));
            let bus = i2c.buses.find(elem => elem.busId === bind.busId);
            if (typeof bus === 'undefined') return Promise.reject(new Error(`setDeviceState: i2c Bus id ${bind.busId} is not initialized. - ${bind.binding}`));
            let dev = bus.devices.find(elem => elem.device.id === this.id);
            if (typeof bus === 'undefined') return Promise.reject(new Error(`setDeviceState: i2c Device id ${bind.busId}:${this.name} is not initialized. - ${bind.binding}`));
            return await dev.setDeviceState(bind, data);
        }
        catch (err) { return Promise.reject(new Error(`setDeviceState: Error setting device state ${err}`)) }
    }
    public async feedDeviceValue(binding: string | DeviceBinding, data: any) {
        try {
            let bind = typeof binding === 'string' ? new DeviceBinding(binding) : binding;
            if (this.isActive === false) return Promise.reject(new Error(`feedDeviceValue: i2c Device ${this.name} not active - ${bind.binding}`));
            let bus = i2c.buses.find(elem => elem.busId === bind.busId);
            if (typeof bus === 'undefined') return Promise.reject(new Error(`feedDeviceValue: i2c Bus id ${bind.busId} is not initialized. - ${bind.binding}`));
            let dev = bus.devices.find(elem => elem.device.id === this.id);
            if (typeof bus === 'undefined') return Promise.reject(new Error(`feedDeviceValue: i2c Device id ${bind.busId}:${this.name} is not initialized. - ${bind.binding}`));
            return await dev.feedDeviceValue(bind, data);
        }
        catch (err) { return Promise.reject(new Error(`feedDeviceValue: Error setting device value ${err}`)) }
    }

}


export class SpiChannelCollection extends ConfigItemCollection<SpiChannel> {
    constructor(data: any, name?: string) { super(data, name || 'channels') }
    public createItem(data: any): SpiChannel { return new SpiChannel(data); }
}
export class SpiChannel extends ConfigItem {
    constructor(data) { super(data); }
    public initData(data?: any) {
        if (typeof this.data.isActive === 'undefined') this.isActive = false;
        if (typeof this.data.feeds === 'undefined') this.data.feeds = [];
        return data;
    }
    public get id(): number { return this.data.id; }
    public set id(val: number) { this.setDataVal('id', val); }
    public get isActive(): boolean { return utils.makeBool(this.data.isActive); }
    public set isActive(val: boolean) { this.setDataVal('isActive', val); }
    public get deviceId(): number { return this.data.deviceId; }
    public set deviceId(val: number) { this.setDataVal('deviceId', val); }
    public get feeds(): DeviceFeedCollection { return new DeviceFeedCollection(this.data, 'feeds'); }
    public get options(): any { return this.data.options; }
    public set options(val: any) { this.data.options = val; }
    public get sampling(): number { return this.data.sampling; }
    public set sampling(val: number) { this.setDataVal('sampling', val); }
    public getExtended() {
        let chan = this.get(true);
        chan.device = cont.analogDevices.find(elem => elem.id === this.deviceId);
        chan.feeds = [];
        for (let i = 0; i < this.feeds.length; i++) {
            chan.feeds.push(this.feeds.getItemByIndex(i).getExtended());
        }
        return chan;
    }
}
export class ConnectionSourceCollection extends ConfigItemCollection<ConnectionSource> {
    constructor(data: any, name?: string) { super(data, name || 'connections') }
    public createItem(data: any): ConnectionSource { return new ConnectionSource(data); }
}
export class ConnectionSource extends ConfigItem {
    constructor(data) { super(data); }
    public initData(data?: any) {
        if (typeof this.data.isActive === 'undefined') this.isActive = false;
        return data;
    }
    public get id(): number { return this.data.id; }
    public set id(val: number) { this.setDataVal('id', val); }
    public get name(): string { return this.data.name; }
    public set name(val: string) { this.setDataVal('name', val); }
    public get isActive(): boolean { return utils.makeBool(this.data.isActive); }
    public set isActive(val: boolean) { this.setDataVal('isActive', val); }
    public get type() { return this.getMapVal(this.data.type || 0, vMaps.connectionTypes); }
    public set type(val) { this.setMapVal('type', val, vMaps.connectionTypes); }
    public get protocol(): string { return this.data.protocol; }
    public set protocol(val: string) { this.setDataVal('protocol', val); }
    public get ipAddress(): string { return this.data.ipAddress; }
    public set ipAddress(val: string) { this.setDataVal('ipAddress', val); }
    public get port(): number { return this.data.port; }
    public set port(val: number) { this.setDataVal('port', val); }
    public get userName(): string { return this.data.userName; }
    public set userName(val: string) { this.setDataVal('userName', val); }
    public get password(): string { return this.data.password; }
    public set password(val: string) { this.setDataVal('password', val); }
    public get sslKeyFile(): string { return this.data.sslKeyFile; }
    public set sslKeyFile(val: string) { this.setDataVal('sslKeyFile', val); }
    public get sslCertFile(): string { return this.data.sslCertFile; }
    public set sslCertFile(val: string) { this.setDataVal('sslCertFile', val); }
    public getExtended() {
        let src = this.get(true);
        src.type = this.type;
        return src;
    }
    public get url(): string {
        let port = typeof this.port !== 'undefined' ? ':' + this.port.toString() : '';
        return `${this.protocol}//${this.ipAddress}${port}`;
    }
    public get options(): any { return typeof this.data.optons === 'undefined' ? this.data.options = {} : this.data.options; }
    public set options(val: any) { this.setDataVal('options', val); }
}


export class GenericDeviceController extends ConfigItem {
    constructor(data, name: string) { super(data, name); }
    public initData(data?: any) {
        if (typeof this.data.isActive === 'undefined') this.isActive = true; // can init to false later if to make it a config item
        if (typeof this.data.buses === 'undefined') this.data.buses = [];
        if (typeof this.data.detected === 'undefined') this.data.detected = [];
        if (typeof this.data.options === 'undefined') this.data.options = {};
        return data;
    }
    // public get id(): number { return this.data.id; }
    // public set id(val: number) { this.setDataVal('id', val); }
    public get isActive(): boolean { return utils.makeBool(this.data.isActive); }
    public set isActive(val: boolean) { this.setDataVal('isActive', val); }
    // public get detected(): any[] { return this.data.detected; }
    // public set detected(val: any[]) { this.data.detected = val; }
    public get devices(): GenericDeviceCollection { return new GenericDeviceCollection(this.data, 'devices'); }
    public getExtended() {
        let c = this.get(true);
        c.devices = this.devices.toExtendedArray();
        return c;
    }
    public async setDeviceValue(typeId: number, id: number, prop: string, value: any) {
        // generic:typeId:id
        let device = this.devices.find(elem => elem.id === id && elem.typeId === typeId);
        if (typeof device !== 'undefined') device.setValue(prop, value);
    }
    public async setDeviceState(binding: string | DeviceBinding, data: any): Promise<any> {
        try {
            let bind = typeof binding === 'string' ? new DeviceBinding(binding) : binding;
            // A valid device binding for generic includes generic:<typeId>:<deviceId>.
            if (isNaN(bind.typeId)) return Promise.reject(new Error(`setDeviceState: Invalid generic device type id ${bind.typeId} - ${bind.binding}`));
            let dev = this.devices.find(elem => elem.id === bind.id && elem.typeId === bind.typeId);
            if (typeof dev === 'undefined') return Promise.reject(new Error(`setDeviceState: generic dev not found ${bind.id} - ${bind.binding}`));
            // At this point we know the protocol and we know the dev so forward this to our dev.
            return await dev.setDeviceState(bind, data);
        }
        catch (err) { return Promise.reject(err); }
    }
    public async feedDeviceValue(binding: string | DeviceBinding, data: any): Promise<any> {
        try {
            let bind = typeof binding === 'string' ? new DeviceBinding(binding) : binding;
            // A valid device binding for generic includes generic:typeId:id.
            if (isNaN(bind.typeId)) return Promise.reject(new Error(`feedDeviceValue: Invalid generic dev id ${bind.typeId} - ${bind.binding}`));
            let dev = this.devices.find(elem => elem.id === bind.id && elem.typeId === bind.typeId);
            if (typeof dev === 'undefined') return Promise.reject(new Error(`feedDeviceValue: generic dev not found ${bind.id} - ${bind.binding}`));
            // At this point we know the protocol and we know the dev so forward this to our dev.
            return await dev.feedDeviceValue(bind, data);
        }
        catch (err) { return Promise.reject(err); }
    }

    public async getDevice(binding: string | DeviceBinding): Promise<any> {
        try {
            let bind = typeof binding === 'string' ? new DeviceBinding(binding) : binding;
            // A valid device binding for generic includes generic:<typeId>:<deviceId>.
            if (isNaN(bind.typeId)) return Promise.reject(new Error(`getDevice: Invalid generic device type id ${bind.typeId} - ${bind.binding}`));
            let dev = this.devices.find(elem => elem.id === bind.id && elem.typeId === bind.typeId);
            if (typeof dev === 'undefined') return Promise.reject(new Error(`getDevice: generic bus not found ${bind.busId} - ${bind.binding}`));
            // At this point we know the protocol and we know the bus so forward this to our bus.
            return Promise.resolve(this.devices.getItemById(bind.id));
        }
        catch (err) { return Promise.reject(err); }
    }
    public async getDeviceState(binding: string | DeviceBinding): Promise<any> {
        try {
            let bind = typeof binding === 'string' ? new DeviceBinding(binding) : binding;
            if (isNaN(bind.id)) return Promise.reject(new Error(`getDeviceState: Invalid generic device id ${bind.typeId} ${bind.id} - ${bind.binding}`));
            let device = this.devices.find(elem => elem.id === bind.id);
            if (typeof device === 'undefined') return Promise.reject(new Error(`getDeviceState: Could not find generic device ${bind.typeId}:${bind.id} - ${bind.binding}`));
            return { status: device.deviceStatus, state: await device.getDeviceState(bind) };
        } catch (err) { return Promise.reject(err); }
    }
    public async getDeviceStatus(binding: string | DeviceBinding): Promise<any> {
        try {
            /*             let bind = typeof binding === 'string' ? new DeviceBinding(binding) : binding;
                        // A valid device binding for i2c includes i2c:<busId>:<deviceId>.
                        if (isNaN(bind.busId)) return Promise.reject(new Error(`getDevice: Invalid i2c bus id ${bind.busId} - ${bind.binding}`));
                        let bus = this.devices.find(elem => elem.id === bind.busId);
                        if (typeof bus === 'undefined') return Promise.reject(new Error(`getDevice: i2c bus not found ${bind.busId} - ${bind.binding}`));
                        // At this point we know the protocol and we know the bus so forward this to our bus.
                        return await bus.getDeviceStatus(bind); */
        }
        catch (err) { return Promise.reject(err); }
    }
    public async setDevice(dev): Promise<GenericDevice> {
        try {
            /*             let busId = (typeof dev.busId !== 'undefined') ? parseInt(dev.busId, 10) : undefined;
                        let busNumber = (typeof dev.busNumber !== 'undefined') ? parseInt(dev.busNumber, 10) : undefined;
                        let bus: I2cBus;
                        if (typeof busId !== 'undefined') {
                            bus = this.devices.getItemById(busId);
                            if (typeof bus.busNumber === 'undefined') return Promise.reject(new Error(`An invalid I2c bus id was supplied ${dev.busId}`));
                        }
                        else if (typeof busNumber !== 'undefined') {
                            bus = this.devices.getItemByBusNumber(busNumber);
                            if (typeof bus.id === 'undefined') return Promise.reject(new Error(`An invalid I2c bus # was supplied ${dev.busNumber}`));
                        }
                        else {
                            return Promise.reject(new Error(`The specified I2c bus could not be found at busId:${dev.busId} or busNumber:${dev.busNumber}`));
                        }
                        let device = await bus.setDevice(dev);
                        return Promise.resolve(device); */

            logger.info(`received ${JSON.stringify(dev)}`);
            let id = parseInt(dev.id, 10);
            if (isNaN(id)) id = this.devices.length + 1; // if devices get deleted, need to make sure we pick a new id.
            dev.id = id;
            let device = this.devices.getItemById(dev.id, true);
            device.set(dev);
            if (typeof dev.options.name !== 'undefined') device.name = dev.options.name;
            return Promise.resolve(device);


        }
        catch (err) { return Promise.reject(err); }
    }
    /*     public async runDeviceCommand(busNumber: number, address: number, command: string, options: any): Promise<any> {
            try {
                let dbus = i2c.devices.find(elem => elem.busNumber === busNumber);
                if (typeof dbus === 'undefined') return Promise.reject(`Cannot execute command Bus #${busNumber} could not be found`);
                let ddevice = dbus.devices.find(elem => elem.device.address === address);
                if (typeof ddevice === 'undefined') { return Promise.reject(`Cannot execute command Bus #${busNumber} Address ${address} could not be found`); }
                let result = await ddevice.callCommand({ name: command, params: [options] });
                return Promise.resolve(result);
            }
            catch (err) { return Promise.reject(err); }
        } */
    public async deleteDevice(dev): Promise<GenericDevice> {
        try {
            if (typeof dev.id === 'undefined') return Promise.reject(`Could not find generic device ith id id ${dev.id}`);
            let device = await this.devices.removeItemById(dev.id);
            return Promise.resolve(device[0]);  // err, why am I getting back an array here instead of a single device.  
        }
        catch (err) { return Promise.reject(err); }
    }

    public getDeviceInputs(): any[] {
        let devices = [];
        let ad = cont.analogDevices;
        for (let i = 0; i < this.devices.length; i++) {
            let device = this.devices.getItemByIndex(i);
            let dev;
            if (typeof device.typeId !== 'undefined' && device.typeId !== 0)
                dev = ad.find(elem => elem.id === device.typeId);
            if (typeof dev !== 'undefined' && typeof dev.inputs !== 'undefined') {
                devices.push({ uid: `generic:${dev.id}:${device.id}`, id: device.id, name: device.name, deviceId: dev.id, type: 'generic', bindings: dev.inputs });
            }
        }
        //console.log(devices);
        return devices;
    }
    /*     public getDeviceById(busId: number, deviceId: number) {
                     let bus = this.devices.getItemById(busId);
                    return bus.getDeviceById(deviceId); 
        } */
    public async setDeviceFeed(data): Promise<DeviceFeedCollection> {
        if (typeof data.busNumber === 'undefined' && typeof data.busId === 'undefined') return Promise.reject(new Error(`A valid i2c bus identifier was not provided`));
        try {
            /*             let busId;
                        let busNumber;
                        let bus;
                        if (typeof data.busId !== 'undefined') {
                            busId = parseInt(data.busId, 10);
                            if (isNaN(busId)) return Promise.reject(new Error(`A valid i2c bus id was not provided ${data.busId}`));
                        }
                        if (typeof data.busNumber !== 'undefined') {
                            busNumber = parseInt(data.busNumber, 10);
                            if (isNaN(busNumber)) return Promise.reject(new Error(`A valid i2c bus # was not provided ${data.busNumber}`));
                        }
                        if (!isNaN(busId)) bus = this.devices.getItemById(busId);
                        else if (!isNaN(busNumber)) bus = this.devices.getItemByBusNumber(busNumber);
                        else return Promise.reject(new Error(`A valid i2c bus identifier was not provided`));
                        return await bus.setDeviceFeed(data); */
        }
        catch (err) { return Promise.reject(err); }
    }
    public async deleteDeviceFeed(data): Promise<DeviceFeedCollection> {
        if (typeof data.busNumber === 'undefined' && typeof data.busId === 'undefined') return Promise.reject(new Error(`A valid i2c bus identifier was not provided`));
        /* try {
            let busId;
            let busNumber;
            let bus;
            if (typeof data.busId !== 'undefined') {
                busId = parseInt(data.busId, 10);
                if (isNaN(busId)) return Promise.reject(new Error(`A valid i2c bus id was not provided ${data.busId}`));
            }
            if (typeof data.busNumber !== 'undefined') {
                busNumber = parseInt(data.busNumber, 10);
                if (isNaN(busNumber)) return Promise.reject(new Error(`A valid i2c bus # was not provided ${data.busNumber}`));
            }
            if (!isNaN(busId)) bus = this.devices.getItemById(busId);
            else if (!isNaN(busNumber)) bus = this.devices.getItemByBusNumber(busNumber);
            else return Promise.reject(new Error(`A valid i2c bus identifier was not provided`));
            return await bus.deleteDeviceFeed(data);
        }
        catch (err) { return Promise.reject(err); } */
    }
}
export class GenericDeviceCollection extends ConfigItemCollection<GenericDevice> {
    constructor(data: any, name?: string) { super(data, name || 'devices') }
    public createItem(data: any): GenericDevice { return new GenericDevice(data); }
    public getItemByAddress(address: number | string, add?: boolean, data?: any): GenericDevice {
        let itm = this.find(elem => elem.address === address && typeof elem.address !== 'undefined');
        if (typeof itm !== 'undefined') return itm;
        let id = this.getMaxId() + 1 || 1;
        if (typeof add !== 'undefined' && add) return this.add(data || { id: id, address: address });
        return this.createItem(data || { address: address });
    }
}
export class GenericDevice extends ConfigItem {
    constructor(data) { super(data); }
    public initData(data?: any) {
        if (typeof this.data.values === 'undefined') this.values = {};
        if (typeof this.data.options === 'undefined') this.options = {};
        if (typeof this.data.info === 'undefined') this.info = {};
    }
    public get id(): number { return this.data.id; }
    public set id(val: number) { this.setDataVal('id', val); }
    public get name(): string { return this.data.name; }
    public set name(val: string) { this.setDataVal('name', val); }
    public get isActive(): boolean { return utils.makeBool(this.data.isActive); }
    public set isActive(val: boolean) { this.setDataVal('isActive', val); }
    public get typeId(): number { return this.data.typeId; }
    public set typeId(val: number) { this.setDataVal('typeId', val); }
    public get address(): number { return this.data.address; }
    public set address(val: number) { this.setDataVal('address', val); }
    public get feeds(): DeviceFeedCollection { return new DeviceFeedCollection(this.data, 'feeds'); }
    public get options(): any { return typeof this.data.options === 'undefined' ? this.data.options = {} : this.data.options; }
    public set options(val: any) { this.setDataVal('options', val || {}); }
    public get info(): any { return typeof this.data.info === 'undefined' ? this.data.info = {} : this.data.info; }
    public set info(val: any) { this.setDataVal('info', val || {}); }
    public get values(): any { return typeof this.data.values === 'undefined' ? this.data.values = {} : this.data.values; }
    public set values(val: any) { this.setDataVal('values', val || {}); }
    public get sampling(): number { return this.data.sampling; }
    public set sampling(val: number) { this.setDataVal('sampling', val); }
    public get deviceStatus(): DeviceStatus { return { name: this.name, category: this.getDeviceType().category, hasFault: false, status: 'ok', lastComm: 0, protocol: 'generic', busNumber: 0, address: this.typeId } }
    public getExtended() {
        let dev = this.get(true);
        dev.deviceType = cont.analogDevices.find(elem => elem.id === this.typeId);
        dev.feeds = [];
        for (let i = 0; i < this.feeds.length; i++) {
            dev.feeds.push(this.feeds.getItemByIndex(i).getExtended());
        }
        return dev;
    }
    public getDeviceType() {
        return cont.analogDevices.find(elem => elem.id === this.typeId);
    }
    public getDeviceDescriptions(dev) {
        // RSG - this can't act the same as the other getDeviceDescriptions because a single dev type can be present multiple times
        // logic taken care of in /devices/all for now
        let desc = [];
        let category = typeof dev !== 'undefined' ? dev.category : 'Unknown';
        desc.push({ type: 'generic', isActive: this.isActive, name: `${typeof this.options.name !== 'undefined' ? this.options.name : dev.name}, binding: generic:${this.typeId}:${this.id}`, category });
        return desc;
    }
    public setValue(prop: string, value) {
        this.values[prop] = value;
        this.doStuff();
    }
    public async setDeviceFeed(data): Promise<DeviceFeed> {
        try {
            let feedId = typeof data.id !== 'undefined' ? parseInt(data.id, 10) : typeof data.feedId !== 'undefined' ? parseInt(data.feedId, 10) : -1;
            if (isNaN(feedId)) return Promise.reject(`The feed identifier is not valid.`);
            let feed: DeviceFeed;
            let connectionId;
            let connection;
            if (feedId !== -1) {
                // We are updating.
                feed = this.feeds.find(elem => elem.id === feedId);
                if (typeof feed === 'undefined') return Promise.reject(`Could not find a feed by id ${feedId}`);
                connectionId = feed.connectionId;
            }
            else {
                // We are adding.
                feedId = (this.feeds.getMaxId() || 0) + 1;
                connectionId = parseInt(data.connectionId, 10);
                if (isNaN(connectionId)) return Promise.reject(new Error(`The feed connection identifier was not supplied.`));
            }
            connection = connectionId !== -1 ? cont.connections.find(elem => elem.id === connectionId) : undefined;
            if (connectionId !== -1 && typeof connection === 'undefined') return Promise.reject(`The feed connection was not found at id ${connectionId}`);
            feed = this.feeds.getItemById(feedId, true);
            feed.connectionId = connectionId;
            feed.set(data);
            feed.id = feedId;
            // Set this on the bus.
            return Promise.resolve(feed);
        }
        catch (err) { return Promise.reject(err); }
    }
    public async deleteDeviceFeed(data): Promise<DeviceFeed> {
        try {
            let feedId = typeof data.id !== 'undefined' ? parseInt(data.id, 10) : typeof data.feedId !== 'undefined' ? parseInt(data.feedId, 10) : -1;
            if (isNaN(feedId)) return Promise.reject(`The feed identifier is not valid.`);
            let feed: DeviceFeed;
            let connectionId;
            let connection;
            feed = this.feeds.getItemById(feedId);
            this.feeds.removeItemById(feedId);
            return Promise.resolve(feed);
        }
        catch (err) { return Promise.reject(err); }
    }
    public async setDeviceState(binding: string | DeviceBinding, data: any) {
        try {
            // let bind = typeof binding === 'string' ? new DeviceBinding(binding) : binding;
            // if (this.isActive === false) return Promise.reject(new Error(`setDeviceState: i2c Device ${this.name} not active - ${bind.binding}`));
            // let bus = i2c.buses.find(elem => elem.busId === bind.busId);
            // if (typeof bus === 'undefined') return Promise.reject(new Error(`setDeviceState: i2c Bus id ${bind.busId} is not initialized. - ${bind.binding}`));
            // let dev = bus.devices.find(elem => elem.device.id === this.id);
            // if (typeof bus === 'undefined') return Promise.reject(new Error(`setDeviceState: i2c Device id ${bind.busId}:${this.name} is not initialized. - ${bind.binding}`));
            // return await dev.setDeviceState(bind, data);
        }
        catch (err) { return Promise.reject(new Error(`setDeviceState: Error setting device state ${err}`)) }
    }
    public async feedDeviceValue(binding: string | DeviceBinding, data: any) {
        try {
            // let bind = typeof binding === 'string' ? new DeviceBinding(binding) : binding;
            // if (this.isActive === false) return Promise.reject(new Error(`feedDeviceValue: i2c Device ${this.name} not active - ${bind.binding}`));
            // let bus = i2c.buses.find(elem => elem.busId === bind.busId);
            // if (typeof bus === 'undefined') return Promise.reject(new Error(`feedDeviceValue: i2c Bus id ${bind.busId} is not initialized. - ${bind.binding}`));
            // let dev = bus.devices.find(elem => elem.device.id === this.id);
            // if (typeof bus === 'undefined') return Promise.reject(new Error(`feedDeviceValue: i2c Device id ${bind.busId}:${this.name} is not initialized. - ${bind.binding}`));
            // return await dev.feedDeviceValue(bind, data);
        }
        catch (err) { return Promise.reject(new Error(`feedDeviceValue: Error setting device value ${err}`)) }
    }
    public doStuff() {
        // Execute a function, load a module, or ...
        let ad = cont.analogDevices.find(elem => elem.id === this.typeId);
        let self = this;
        if (typeof ad.convertValue !== 'undefined') {
            let fn = new Function("device", ad.convertValue);
            fn(self);
        }
        else if (typeof ad.module !== 'undefined') {
            // load/store/do something with the module
        }
        webApp.emitToClients('genericDataValues', { id: this.id, typeId: this.typeId, values: this.values });
        this.emitFeeds();
    }
    public getValue(prop: string) {
        switch (prop) {
            case 'all': { return this.values; }
            default: {
                return this.values[prop];
            }
        }
    }
    public async getDeviceState(binding: string | DeviceBinding): Promise<any> {
        try {
            let bind = (typeof binding === 'string') ? new DeviceBinding(binding) : binding;
            // We need to know what value we are referring to.
            if (typeof bind.params[0] === 'string') return this.getValue(bind.params[0]);
            let prop = this.getDeviceType().outputs[0].name;
            return Promise.resolve(this.values[prop]);
        } catch (err) { return Promise.reject(err); }
    }
    public async emitFeeds() {
        try {
            for (let i = 0; i < this.feeds.length; i++) {
                await this.feeds[i].send(this);
            }
        } catch (err) { logger.error(err); }
    }
}
export let cont = new Controller({});