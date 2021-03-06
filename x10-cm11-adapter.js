/******************************************************************************
 *
 * The MIT License (MIT)
 *
 * Copyright (c) 2020 Alan Thiessen
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 *
 ******************************************************************************/

'use strict';


const {
    Adapter,    // Adapter base class
    Database,   // Class for interacting with the gateway's settings database
    Device,     // Device base class
    Property,   // Property base class
} = require('gateway-addon');

const CM11A = require('cm11a-js');
const manifest = require('./manifest.json');


const STATUS_PROP_MAP = {
    'ON':       { prop: 'on', value: true  },
    'OFF':      { prop: 'on', value: false },
    'DIM':      { prop: 'level', value: -1 },
    'BRIGHT':   { prop: 'level', value: 1 }
};


function bool() {
    return {
        name: 'on',
        value: false,
        metadata: {
            '@type': 'BooleanProperty',
            type: 'boolean'
        }
    }
}


function on() {
    return {
        name: 'on',
        value: false,
        metadata: {
            '@type': 'OnOffProperty',
            label: 'On/Off',
            type: 'boolean'
        }
    }
}


function brightness() {
    return {
        name: 'level',
        value: 100,
        metadata: {
            '@type': 'BrightnessProperty',
            label: 'Brightness',
            type: 'number',
            unit: 'percent'
        }
    }
}


function level() {
    return {
        name: 'level',
        value: 100,
        metadata: {
            '@type': 'LevelProperty',
            label: 'Level',
            type: 'number',
            unit: 'percent'
        }
    }
}


const x10LampModule = {
    name: 'Lamp Module',
    '@type': ['OnOffSwitch', 'Light'],
    type: 'dimmableLight',
    properties: [
        on(),
        brightness()
    ]
};


const x10ApplianceModule = {
    name: 'Appliance Module',
    '@type': ['OnOffSwitch', 'Light'],
    type: 'onOffLight',
    properties: [
        on()
    ]
};


const x10OnOffSwitch = {
    name: 'On/Off Switch',
    '@type': ['OnOffSwitch'],
    type: 'onOffSwitch',
    properties: [
        on()
    ]
};


const x10DimmerSwitch = {
    name: 'Dimmer Switch',
    '@type': ['OnOffSwitch', 'MultiLevelSwitch'],
    type: 'multiLevelSwitch',
    properties: [
        on(),
        level()
    ]
};


const x10OnOffSensor = {
    name: 'On/Off Sensor',
    '@type': ['BinarySensor'],
    type: 'binarySensor',
    properties: [
        bool()
    ]
};



const X10_DEVICE_TYPES = {
    'Lamp Module': x10LampModule,
    'Appliance Module': x10ApplianceModule,
    'On/Off Switch': x10OnOffSwitch,
    'Dimmer Switch': x10DimmerSwitch,
    'On/Off Sensor': x10OnOffSensor
};


class X10Property extends Property {
    constructor(device, name, descr, value) {
        super(device, name, descr);
        this.setCachedValue(value);

        if(this.name === 'level') {
            this.adjust = {
                'oldLevel': value,
                'func': 'bright',
                'amount': 0
            }
        }
    }

    setValue(value) {
        if(this.name === 'level') {
            let percentDiff = Math.abs(value - this.adjust.oldLevel);
            this.adjust.amount = Math.round(percentDiff / 100 * 22);    // The maximum value is 22

            if(value >= this.adjust.oldLevel) {
                this.adjust.func = 'bright';
            }
            else {
                this.adjust.func = 'dim';
            }

            this.adjust.oldLevel = value;
        }

        return new Promise(resolve => {
            this.setCachedValue(value);
            resolve(this.value);
            this.device.notifyPropertyChanged(this);
        });
    }
}



class X10Device extends Device {
    /**
     * @param {X10CM11Adapter} adapter
     * @param {String} id - A globally unique identifier
     * @param {String} x10Addr - The X10 protocol address of the device
     * @param {String} moduleType - A string indicating which type of module this device controls
     */
    constructor(adapter, id, x10Addr, moduleType) {
        super(adapter, id);

        let template = X10_DEVICE_TYPES[moduleType];
        this.name = 'X10 ' + template.name + ' (' + x10Addr + ')';
        this.type = template.type;
        this['@type'] = template['@type'];
        this.x10Addr = x10Addr;

        console.log(template.properties);
        for (let prop of template.properties) {
            this.properties.set(prop.name,
                new X10Property(this, prop.name, prop.metadata, prop.value));
        }

        console.log('CM11A Device Added: ' + this.name + ' with address ' + this.x10Addr);

        this.adapter.handleDeviceAdded(this);
    }

    notifyPropertyChanged(property) {
        super.notifyPropertyChanged(property);

        console.log('CM11A Property changed for ' + this.x10Addr + ': ' + property.name + ' = ' + property.value);

        switch (property.name) {
            case 'on': {
                if (property.value) {
                    let level = 100;

                    if (this.hasProperty('level')) {
                        level = this.properties.get('level').value;
                    }

                    this.adapter.cm11a.turnOn([this.x10Addr]);

                    if (level < '100') {
                        // TODO: I believe there is an X10 Extended cdde to set the level before turning the device on.
                        let amount = Math.round((100 - level) / 100 * 22);
                        this.adapter.cm11a.dim([this.x10Addr], amount);
                    }
                }
                else {
                    this.adapter.cm11a.turnOff([this.x10Addr]);
                }
                break;
            }

            case 'level': {
                if (this.hasProperty('on') && this.properties.get('on').value) {
                    console.log('CM11A Adjusting level: ' + property.adjust.func + ' = ' + property.adjust.amount);
                    this.adapter.cm11a[property.adjust.func]([this.x10Addr], property.adjust.amount);
                }
                break;
            }
        }
    }


    updatePropertyValue(propMapEntry, propValue) {
        if (this.hasProperty(propMapEntry.prop)) {
            let property = this.properties.get(propMapEntry.prop);
            let newValue = property.value;

            if (propMapEntry.prop === 'level') {
                newValue += (propMapEntry.value * propValue);
                if(newValue > 100) { newValue = 100; }
                if(newValue <   0) { newValue =   0; }
            }
            else {
                newValue = propMapEntry.value;
            }

            if (property.value != newValue) {
                property.setCachedValue(newValue);
                super.notifyPropertyChanged(property);
            }
        }
    }
}



class X10CM11Adapter extends Adapter {
    constructor(addonManager, config) {
        super(addonManager, 'x10-unknown', manifest.id);

        this.configuredModules = config.modules;
        this.serialDevice = config.device;
        this.cm11a = CM11A();

        this.cm11a.on('unitStatus', (status) => {
            this.unitStatusReported(status);
        });

        console.log('CM11A: Opening ' + this.serialDevice);
        this.cm11a.start(this.serialDevice);

        // Set the CM11A clock once a day to prevent drift
        this.setClockInterval = setInterval(() => {
            console.log("CM11A: Setting Clock");
            this.cm11a.setClock();
        }, (24 * 60 * 60 * 1000));

        addonManager.addAdapter(this);

        this.addModules();
    }


    startPairing() {
        this.addModules();
    }


    addModules() {
        for(let i = 0; i < this.configuredModules.length; i++) {
            let module = this.configuredModules[i];
            let id = 'x10-' + module.houseCode + module.unitCode;
            let x10Addr = module.houseCode + module.unitCode;

            if(!this.devices[id]) {
                new X10Device(this, id, x10Addr, module.moduleType);
            }
        }
    }


    unitStatusReported(status) {
        console.log('CM11A Update Status: ' + status);

        if(STATUS_PROP_MAP.hasOwnProperty(status.x10Function)) {
            status.units.forEach((unit) => {
                let device = this.getDevice('x10-' + unit);

                if(device !== undefined) {
                    device.updatePropertyValue(STATUS_PROP_MAP[status.x10Function], status.level);
                }
            });
        }
    }

    unload() {
        return new Promise(resolve => {
            this.cm11a.on('close', () => {
                console.log('CM11A Stopped.');
                resolve();
            });

            console.log('CM11A Stopping...');
            this.cm11a.stop();
            clearInterval(this.setClockInterval);
        });
    }
}


function LoadX10CM11Adapter(addonManager, _, errorCallback) {
    const db = new Database(manifest.id);
    db.open().then(() => {
        return db.loadConfig();
    }).then((config) => {
        new X10CM11Adapter(addonManager, config);
    }).catch((e) => {
        errorCallback(manifest.id, `Failed to open database: ${e}`);
    });
}


module.exports = LoadX10CM11Adapter;

