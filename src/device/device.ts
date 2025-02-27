/* Copyright(C) 2021-2024, donavanbecker (https://github.com/donavanbecker). All rights reserved.
 *
 * device.ts: @switchbot/homebridge-switchbot.
 */

import type { API, CharacteristicValue, HAP, Logging, PlatformAccessory, Service } from 'homebridge'
import type { MqttClient } from 'mqtt'
import type { ad, bodyChange, device, deviceStatus, deviceStatusRequest, pushResponse } from 'node-switchbot'

import type { SwitchBotPlatform } from '../platform.js'
import type { blindTiltConfig, botConfig, ceilingLightConfig, colorBulbConfig, contactConfig, curtainConfig, devicesConfig, hubConfig, humidifierConfig, indoorOutdoorSensorConfig, lockConfig, meterConfig, motionConfig, plugConfig, stripLightConfig, SwitchBotPlatformConfig, waterDetectorConfig } from '../settings.js'

import { hostname } from 'node:os'

import { SwitchBotBLEModel, SwitchBotBLEModelFriendlyName, SwitchBotBLEModelName, SwitchBotModel } from 'node-switchbot'

import { formatDeviceIdAsMac, sleep } from '../utils.js'

export abstract class deviceBase {
  public readonly api: API
  public readonly log: Logging
  public readonly config!: SwitchBotPlatformConfig
  protected readonly hap: HAP

  // Config
  protected deviceLogging!: string
  protected deviceRefreshRate!: number
  protected deviceUpdateRate!: number
  protected devicePushRate!: number
  protected deviceMaxRetries!: number
  protected deviceDelayBetweenRetries!: number

  // Connection
  protected readonly BLE: boolean
  protected readonly OpenAPI: boolean

  // Accsrroy Information
  protected deviceModel!: SwitchBotModel
  protected deviceBLEModel!: SwitchBotBLEModel

  // MQTT
  protected deviceMqttURL!: string
  protected deviceMqttOptions!: any
  protected deviceMqttPubOptions!: any

  // BLE
  protected scanDuration!: number

  // EVE history service handler
  protected historyService?: any = null

  // MQTT stuff
  protected mqttClient: MqttClient | null = null

  constructor(
    protected readonly platform: SwitchBotPlatform,
    protected accessory: PlatformAccessory,
    protected device: device & devicesConfig,
  ) {
    this.api = this.platform.api
    this.log = this.platform.log
    this.config = this.platform.config
    this.hap = this.api.hap

    // Connection
    this.BLE = this.device.connectionType === 'BLE' || this.device.connectionType === 'BLE/OpenAPI'
    this.OpenAPI = this.device.connectionType === 'OpenAPI' || this.device.connectionType === 'BLE/OpenAPI'

    this.getDeviceLogSettings(device)
    this.getDeviceRateSettings(device)
    this.getDeviceConfigSettings(device)
    this.getDeviceContext(accessory, device)
    this.getMqttSettings(device)

    // Set accessory information
    accessory
      .getService(this.hap.Service.AccessoryInformation)!
      .setCharacteristic(this.hap.Characteristic.Manufacturer, 'SwitchBot')
      .setCharacteristic(this.hap.Characteristic.AppMatchingIdentifier, 'id1087374760')
      .setCharacteristic(this.hap.Characteristic.Name, accessory.displayName)
      .setCharacteristic(this.hap.Characteristic.ConfiguredName, accessory.displayName)
      .setCharacteristic(this.hap.Characteristic.Model, device.model)
      .setCharacteristic(this.hap.Characteristic.ProductData, device.deviceId)
      .setCharacteristic(this.hap.Characteristic.SerialNumber, device.deviceId)
  }

  async getDeviceLogSettings(device: device & devicesConfig): Promise<void> {
    this.deviceLogging = this.platform.debugMode ? 'debugMode' : device.logging ?? this.platform.platformLogging ?? 'standard'
    const logging = this.platform.debugMode ? 'Debug Mode' : device.logging ? 'Device Config' : this.platform.platformLogging ? 'Platform Config' : 'Default'
    this.debugLog(`Using ${logging} Logging: ${this.deviceLogging}`)
  }

  async getDeviceRateSettings(device: device & devicesConfig): Promise<void> {
    // refreshRate
    this.deviceRefreshRate = device.refreshRate ?? this.platform.platformRefreshRate ?? 300
    const refreshRate = device.refreshRate ? 'Device Config' : this.platform.platformRefreshRate ? 'Platform Config' : 'Default'
    // updateRate
    this.deviceUpdateRate = device.updateRate ?? this.platform.platformUpdateRate ?? 5
    const updateRate = device.updateRate ? 'Device Config' : this.platform.platformUpdateRate ? 'Platform Config' : 'Default'
    // pushRate
    this.devicePushRate = device.pushRate ?? this.platform.platformPushRate ?? 0.1
    const pushRate = device.pushRate ? 'Device Config' : this.platform.platformPushRate ? 'Platform Config' : 'Default'
    this.debugLog(`Using ${refreshRate} refreshRate: ${this.deviceRefreshRate}, ${updateRate} updateRate: ${this.deviceUpdateRate}, ${pushRate} pushRate: ${this.devicePushRate}`)
    // maxRetries
    this.deviceMaxRetries = device.maxRetries ?? this.platform.platformMaxRetries ?? 2
    const maxRetries = device.maxRetries ? 'Device' : this.platform.platformMaxRetries ? 'Platform' : 'Default'
    this.debugLog(`Using ${maxRetries} Max Retries: ${this.deviceMaxRetries}`)
    // delayBetweenRetries
    this.deviceDelayBetweenRetries = device.delayBetweenRetries ? (device.delayBetweenRetries * 1000) : this.platform.platformDelayBetweenRetries ?? 3000
    const delayBetweenRetries = device.delayBetweenRetries ? 'Device' : this.platform.platformDelayBetweenRetries ? 'Platform' : 'Default'
    this.debugLog(`Using ${delayBetweenRetries} Delay Between Retries: ${this.deviceDelayBetweenRetries}`)
    // scanDuration
    this.scanDuration = Math.max(device.scanDuration ?? 1, this.deviceUpdateRate > 1 ? this.deviceUpdateRate : 1)
    if (this.BLE) {
      this.debugLog(`Using ${device.scanDuration ? 'Device Config' : 'Default'} scanDuration: ${this.scanDuration}`)
      if (device.scanDuration && this.deviceUpdateRate > device.scanDuration) {
        this.warnLog('scanDuration is less than updateRate, overriding scanDuration with updateRate')
      }
    }
  }

  async retryBLE({ max, fn }: { max: number, fn: { (): any, (): Promise<any> } }): Promise<null> {
    return fn().catch(async (e: any) => {
      if (max === 0) {
        throw e
      }
      this.warnLog(e)
      this.infoLog('Retrying')
      await sleep(1000)
      return this.retryBLE({ max: max - 1, fn })
    })
  }

  maxRetryBLE(): number {
    return this.device.maxRetry !== undefined ? this.device.maxRetry : 5
  }

  async getDeviceConfigSettings(device: device & devicesConfig): Promise<void> {
    const deviceConfig = Object.assign(
      {},
      device.logging !== 'standard' && { logging: device.logging },
      device.refreshRate !== 0 && { refreshRate: device.refreshRate },
      device.updateRate !== 0 && { updateRate: device.updateRate },
      device.scanDuration !== 0 && { scanDuration: device.scanDuration },
      device.offline === true && { offline: device.offline },
      device.maxRetry !== 0 && { maxRetry: device.maxRetry },
      device.webhook === true && { webhook: device.webhook },
      device.connectionType !== '' && { connectionType: device.connectionType },
      device.external === true && { external: device.external },
      device.mqttURL !== '' && { mqttURL: device.mqttURL },
      device.mqttOptions && { mqttOptions: device.mqttOptions },
      device.mqttPubOptions && { mqttPubOptions: device.mqttPubOptions },
      device.maxRetries !== 0 && { maxRetries: device.maxRetries },
      device.delayBetweenRetries !== 0 && { delayBetweenRetries: device.delayBetweenRetries },
    )
    let deviceSpecificConfig = {}
    switch (device.configDeviceType) {
      case 'Bot':
        deviceSpecificConfig = device as botConfig
        break
      case 'Meter':
      case 'MeterPlus':
        deviceSpecificConfig = device as meterConfig
        break
      case 'WoIOSensor':
        deviceSpecificConfig = device as indoorOutdoorSensorConfig
        break
      case 'Humidifier':
        deviceSpecificConfig = device as humidifierConfig
        break
      case 'Curtain':
      case 'Curtain3':
        deviceSpecificConfig = device as curtainConfig
        break
      case 'Blind Tilt':
        deviceSpecificConfig = device as blindTiltConfig
        break
      case 'Contact Sensor':
        deviceSpecificConfig = device as contactConfig
        break
      case 'Motion Sensor':
        deviceSpecificConfig = device as motionConfig
        break
      case 'Water Detector':
        deviceSpecificConfig = device as waterDetectorConfig
        break
      case 'Plug':
      case 'Plug Mini (US)':
      case 'Plug Mini (JP)':
        deviceSpecificConfig = device as plugConfig
        break
      case 'Color Bulb':
        deviceSpecificConfig = device as colorBulbConfig
        break
      case 'Strip Light':
        deviceSpecificConfig = device as stripLightConfig
        break
      case 'Ceiling Light':
      case 'Ceiling Light Pro':
        deviceSpecificConfig = device as ceilingLightConfig
        break
      case 'Smart Lock':
      case 'Smart Lock Pro':
        deviceSpecificConfig = device as lockConfig
        break
      case 'Hub 2':
        deviceSpecificConfig = device as hubConfig
        break
      default:
    }
    const config = Object.assign(
      {},
      deviceConfig,
      deviceSpecificConfig,
    )

    if (Object.keys(config).length !== 0) {
      this.debugSuccessLog(`Config: ${JSON.stringify(config)}`)
    }
  }

  /**
   * Get the current ambient light level based on the light level, set_minLux, set_maxLux, and spaceBetweenLevels.
   * @param lightLevel number
   * @param set_minLux number
   * @param set_maxLux number
   * @param spaceBetweenLevels number
   * @returns CurrentAmbientLightLevel
   */
  getLightLevel(lightLevel: number, set_minLux: number, set_maxLux: number, spaceBetweenLevels: number): number {
    const numberOfLevels = spaceBetweenLevels + 1
    this.debugLog(`LightLevel: ${lightLevel}, set_minLux: ${set_minLux}, set_maxLux: ${set_maxLux}, spaceBetweenLevels: ${spaceBetweenLevels}, numberOfLevels: ${numberOfLevels}`)
    const CurrentAmbientLightLevel = lightLevel === 1
      ? set_minLux
      : lightLevel === numberOfLevels
        ? set_maxLux
        : ((set_maxLux - set_minLux) / spaceBetweenLevels) * (Number(lightLevel) - 1)
    this.debugLog(`CurrentAmbientLightLevel: ${CurrentAmbientLightLevel}, LightLevel: ${lightLevel}, set_minLux: ${set_minLux}, set_maxLux: ${set_maxLux}`)
    return CurrentAmbientLightLevel
  }

  /*
   * Publish MQTT message for topics of
   * 'homebridge-switchbot/${this.device.deviceType}/xx:xx:xx:xx:xx:xx'
   */
  async mqttPublish(message: string, topic?: string) {
    const mac = this.device.deviceId?.toLowerCase().match(/[\s\S]{1,2}/g)?.join(':')
    const options = this.deviceMqttPubOptions ?? {}
    const mqttTopic = topic ? `/${topic}` : ''
    const mqttMessageTopic = topic ? `${topic}/` : ''
    this.mqttClient?.publish(`homebridge-switchbot/${this.device.deviceType}/${mac}${mqttTopic}`, `${message}`, options)
    this.debugLog(`MQTT message: ${mqttMessageTopic}${message} options:${JSON.stringify(options)}`)
  }

  /*
   * MQTT Settings
   */
  async getMqttSettings(device: device & devicesConfig): Promise<void> {
    // mqttURL
    this.deviceMqttURL = device.mqttURL ?? this.config.options?.mqttURL ?? ''
    const mqttURL = device.mqttURL ? 'Device Config' : this.config.options?.mqttURL ? 'Platform Config' : 'Default'
    // mqttOptions
    this.deviceMqttOptions = device.mqttOptions ?? this.config.options?.mqttOptions ?? {}
    const mqttOptions = device.mqttOptions ? 'Device Config' : this.config.options?.mqttOptions ? 'Platform Config' : 'Default'
    // mqttPubOptions
    this.deviceMqttPubOptions = device.mqttPubOptions ?? this.config.options?.mqttPubOptions ?? {}
    const mqttPubOptions = device.mqttPubOptions ? 'Device Config' : this.config.options?.mqttPubOptions ? 'Platform Config' : 'Default'
    this.debugLog(`Using ${mqttURL} MQTT URL: ${this.deviceMqttURL}, ${mqttOptions} mqttOptions: ${JSON.stringify(this.deviceMqttOptions)}, ${mqttPubOptions} mqttPubOptions: ${JSON.stringify(this.deviceMqttPubOptions)}`)
  }

  /*
   * Setup EVE history graph feature if enabled.
   */
  async setupHistoryService(accessory: PlatformAccessory, device: device & devicesConfig): Promise<void> {
    try {
      const formattedDeviceId = formatDeviceIdAsMac(this.device.deviceId)
      this.device.bleMac = formattedDeviceId
      this.debugLog(`bleMac: ${this.device.bleMac}`)
      this.historyService = device.history
        ? new this.platform.fakegatoAPI('room', accessory, {
          log: this.platform.log,
          storage: 'fs',
          filename: `${hostname().split('.')[0]}_${this.device.bleMac}_persist.json`,
        })
        : null
    } catch (error) {
      this.errorLog(`failed to format device ID as MAC, Error: ${error}`)
    }
  }

  async switchbotBLE(): Promise<any> {
    const switchBotBLE = await this.platform.connectBLE(this.accessory, this.device)
    // Convert to BLE Address
    try {
      const formattedDeviceId = formatDeviceIdAsMac(this.device.deviceId)
      this.device.bleMac = formattedDeviceId
      await this.getCustomBLEAddress(switchBotBLE)
      this.debugLog(`bleMac: ${this.device.bleMac}`)
      return switchBotBLE
    } catch (error) {
      this.errorLog(`failed to format device ID as MAC, Error: ${error}`)
    }
  }

  async monitorAdvertisementPackets(switchbot: any) {
    this.debugLog(`Scanning for ${this.device.bleModelName} devices...`)
    try {
      await switchbot.startScan({ model: this.device.bleModel, id: this.device.bleMac })
    } catch (e: any) {
      this.errorLog(`Failed to start BLE scanning. Error:${e.message ?? e}`)
    }
    // Set an event handler
    let serviceData = { model: this.device.bleModel, modelName: this.device.bleModelName } as ad['serviceData']
    switchbot.onadvertisement = (ad: ad) => {
      if (this.device.bleMac === ad.address && ad.serviceData.model === this.device.bleModel) {
        this.debugLog(`${JSON.stringify(ad, null, '  ')}`)
        this.debugLog(`address: ${ad.address}, model: ${ad.serviceData.model}`)
        this.debugLog(`serviceData: ${JSON.stringify(ad.serviceData)}`)
        serviceData = ad.serviceData
      }
    }
    // Wait
    await switchbot.wait(this.scanDuration * 1000)
    // Stop to monitor
    try {
      await switchbot.stopScan()
    } catch (e: any) {
      this.errorLog(`Failed to stop BLE scanning. Error:${e.message ?? e}`)
    }
    return serviceData
  }

  async getCustomBLEAddress(switchbot: any): Promise<void> {
    if (this.device.customBLEaddress && this.deviceLogging.includes('debug')) {
      this.debugLog(`customBLEaddress: ${this.device.customBLEaddress}`);
      (async () => {
        // Start to monitor advertisement packets
        try {
          await switchbot.startScan({ model: this.device.bleModel })
        } catch (e: any) {
          this.errorLog(`Failed to start BLE scanning. Error:${e.message ?? e}`)
        }
        // Set an event handler
        switchbot.onadvertisement = (ad: ad) => {
          this.warnLog(`ad: ${JSON.stringify(ad, null, '  ')}`)
        }
        await sleep(10000)
        // Stop to monitor
        try {
          switchbot.stopScan()
        } catch (e: any) {
          this.errorLog(`Failed to stop BLE scanning. Error:${e.message ?? e}`)
        }
      })()
    }
  }

  async pushChangeRequest(bodyChange: bodyChange): Promise<{ body: pushResponse['body'], statusCode: pushResponse['statusCode'] }> {
    const { response, statusCode } = await this.platform.switchBotAPI.controlDevice(this.device.deviceId, bodyChange.command, bodyChange.parameter, bodyChange.commandType)
    return { body: response, statusCode }
  }

  async deviceRefreshStatus(): Promise<{ body: deviceStatus, statusCode: deviceStatusRequest['statusCode'] }> {
    const { response, statusCode } = await this.platform.retryRequest(this.device.deviceId, this.deviceMaxRetries, this.deviceDelayBetweenRetries)
    return { body: response, statusCode }
  }

  async successfulStatusCodes(deviceStatus: deviceStatusRequest) {
    return (deviceStatus.statusCode === 200 || deviceStatus.statusCode === 100)
  }

  /**
   * Update the characteristic value and log the change.
   *
   * @param Service Service
   * @param Characteristic Characteristic
   * @param CharacteristicValue CharacteristicValue | undefined
   * @param CharacteristicName string
   * @param history object
   * @return: void
   *
   */
  async updateCharacteristic(Service: Service, Characteristic: any, CharacteristicValue: CharacteristicValue | undefined, CharacteristicName: string, history?: object): Promise<void> {
    if (CharacteristicValue === undefined) {
      this.debugLog(`${CharacteristicName}: ${CharacteristicValue}`)
    } else {
      await this.mqtt(CharacteristicName, CharacteristicValue)
      if (this.device.history) {
        this.historyService?.addEntry(history)
      }
      Service.updateCharacteristic(Characteristic, CharacteristicValue)
      this.debugLog(`updateCharacteristic ${CharacteristicName}: ${CharacteristicValue}`)
      this.debugWarnLog(`${CharacteristicName} context before: ${this.accessory.context[CharacteristicName]}`)
      this.accessory.context[CharacteristicName] = CharacteristicValue
      this.debugWarnLog(`${CharacteristicName} context after: ${this.accessory.context[CharacteristicName]}`)
    }
  }

  async mqtt(CharacteristicName: string, CharacteristicValue: CharacteristicValue) {
    if (this.device.mqttURL) {
      this.mqttPublish(CharacteristicName, CharacteristicValue.toString())
    }
  }

  async getDeviceContext(accessory: PlatformAccessory, device: device & devicesConfig): Promise<void> {
    const deviceMapping = {
      'Humidifier': {
        model: SwitchBotModel.Humidifier,
        bleModel: SwitchBotBLEModel.Humidifier,
        bleModelName: SwitchBotBLEModelName.Humidifier,
        bleModelFriendlyName: SwitchBotBLEModelFriendlyName.Humidifier,
      },
      'Hub Mini': {
        model: SwitchBotModel.HubMini,
        bleModel: SwitchBotBLEModel.Unknown,
        bleModelName: SwitchBotBLEModelName.Unknown,
        bleModelFriendlyName: SwitchBotBLEModelFriendlyName.Unknown,
      },
      'Hub Plus': {
        model: SwitchBotModel.HubPlus,
        bleModel: SwitchBotBLEModel.Unknown,
        bleModelName: SwitchBotBLEModelName.Unknown,
        bleModelFriendlyName: SwitchBotBLEModelFriendlyName.Unknown,
      },
      'Hub 2': {
        model: SwitchBotModel.Hub2,
        bleModel: SwitchBotBLEModel.Hub2,
        bleModelName: SwitchBotBLEModelName.Hub2,
        bleModelFriendlyName: SwitchBotBLEModelFriendlyName.Hub2,
      },
      'Bot': {
        model: SwitchBotModel.Bot,
        bleModel: SwitchBotBLEModel.Bot,
        bleModelName: SwitchBotBLEModelName.Bot,
        bleModelFriendlyName: SwitchBotBLEModelFriendlyName.Bot,
      },
      'Meter': {
        model: SwitchBotModel.Meter,
        bleModel: SwitchBotBLEModel.Meter,
        bleModelName: SwitchBotBLEModelName.Meter,
        bleModelFriendlyName: SwitchBotBLEModelFriendlyName.Meter,
      },
      'MeterPlus': {
        model: SwitchBotModel.MeterPlusUS,
        bleModel: SwitchBotBLEModel.MeterPlus,
        bleModelName: SwitchBotBLEModelName.MeterPlus,
        bleModelFriendlyName: SwitchBotBLEModelFriendlyName.MeterPlus,
      },
      'Meter Plus (JP)': {
        model: SwitchBotModel.MeterPlusJP,
        bleModel: SwitchBotBLEModel.MeterPlus,
        bleModelName: SwitchBotBLEModelName.MeterPlus,
        bleModelFriendlyName: SwitchBotBLEModelFriendlyName.MeterPlus,
      },
      'Meter Pro': {
        model: SwitchBotModel.MeterPro,
        bleModel: SwitchBotBLEModel.MeterPro,
        bleModelName: SwitchBotBLEModelName.MeterPro,
        bleModelFriendlyName: SwitchBotBLEModelFriendlyName.MeterPro,
      },
      'MeterPro(CO2)': {
        model: SwitchBotModel.MeterProCO2,
        bleModel: SwitchBotBLEModel.MeterProCO2,
        bleModelName: SwitchBotBLEModelName.MeterProCO2,
        bleModelFriendlyName: SwitchBotBLEModelFriendlyName.MeterProCO2,
      },
      'WoIOSensor': {
        model: SwitchBotModel.OutdoorMeter,
        bleModel: SwitchBotBLEModel.OutdoorMeter,
        bleModelName: SwitchBotBLEModelName.OutdoorMeter,
        bleModelFriendlyName: SwitchBotBLEModelFriendlyName.OutdoorMeter,
      },
      'Water Detector': {
        model: SwitchBotModel.WaterDetector,
        bleModel: SwitchBotBLEModel.Leak,
        bleModelName: SwitchBotBLEModelName.Leak,
        bleModelFriendlyName: SwitchBotBLEModelFriendlyName.Leak,
      },
      'Motion Sensor': {
        model: SwitchBotModel.MotionSensor,
        bleModel: SwitchBotBLEModel.MotionSensor,
        bleModelName: SwitchBotBLEModelName.MotionSensor,
        bleModelFriendlyName: SwitchBotBLEModelFriendlyName.MotionSensor,
      },
      'Contact Sensor': {
        model: SwitchBotModel.ContactSensor,
        bleModel: SwitchBotBLEModel.ContactSensor,
        bleModelName: SwitchBotBLEModelName.ContactSensor,
        bleModelFriendlyName: SwitchBotBLEModelFriendlyName.ContactSensor,
      },
      'Curtain': {
        model: SwitchBotModel.Curtain,
        bleModel: SwitchBotBLEModel.Curtain,
        bleModelName: SwitchBotBLEModelName.Curtain,
        bleModelFriendlyName: SwitchBotBLEModelFriendlyName.Curtain,
      },
      'Curtain3': {
        model: SwitchBotModel.Curtain3,
        bleModel: SwitchBotBLEModel.Curtain3,
        bleModelName: SwitchBotBLEModelName.Curtain3,
        bleModelFriendlyName: SwitchBotBLEModelFriendlyName.Curtain3,
      },
      'WoRollerShade': {
        model: SwitchBotModel.Curtain3,
        bleModel: SwitchBotBLEModel.Curtain3,
        bleModelName: SwitchBotBLEModelName.Curtain3,
        bleModelFriendlyName: SwitchBotBLEModelFriendlyName.Curtain3,
      },
      'Roller Shade': {
        model: SwitchBotModel.Curtain3,
        bleModel: SwitchBotBLEModel.Curtain3,
        bleModelName: SwitchBotBLEModelName.Curtain3,
        bleModelFriendlyName: SwitchBotBLEModelFriendlyName.Curtain3,
      },
      'Blind Tilt': {
        model: SwitchBotModel.BlindTilt,
        bleModel: SwitchBotBLEModel.BlindTilt,
        bleModelName: SwitchBotBLEModelName.BlindTilt,
        bleModelFriendlyName: SwitchBotBLEModelFriendlyName.BlindTilt,
      },
      'Plug': {
        model: SwitchBotModel.Plug,
        bleModel: SwitchBotBLEModel.PlugMiniUS,
        bleModelName: SwitchBotBLEModelName.PlugMini,
        bleModelFriendlyName: SwitchBotBLEModelFriendlyName.PlugMini,
      },
      'Plug Mini (US)': {
        model: SwitchBotModel.PlugMiniUS,
        bleModel: SwitchBotBLEModel.PlugMiniUS,
        bleModelName: SwitchBotBLEModelName.PlugMini,
        bleModelFriendlyName: SwitchBotBLEModelFriendlyName.PlugMini,
      },
      'Plug Mini (JP)': {
        model: SwitchBotModel.PlugMiniJP,
        bleModel: SwitchBotBLEModel.PlugMiniJP,
        bleModelName: SwitchBotBLEModelName.PlugMini,
        bleModelFriendlyName: SwitchBotBLEModelFriendlyName.PlugMini,
      },
      'Smart Lock': {
        model: SwitchBotModel.Lock,
        bleModel: SwitchBotBLEModel.Lock,
        bleModelName: SwitchBotBLEModelName.Lock,
        bleModelFriendlyName: SwitchBotBLEModelFriendlyName.Lock,
      },
      'Smart Lock Pro': {
        model: SwitchBotModel.LockPro,
        bleModel: SwitchBotBLEModel.LockPro,
        bleModelName: SwitchBotBLEModelName.LockPro,
        bleModelFriendlyName: SwitchBotBLEModelFriendlyName.LockPro,
      },
      'Color Bulb': {
        model: SwitchBotModel.ColorBulb,
        bleModel: SwitchBotBLEModel.ColorBulb,
        bleModelName: SwitchBotBLEModelName.ColorBulb,
        bleModelFriendlyName: SwitchBotBLEModelFriendlyName.ColorBulb,
      },
      'K10+': {
        model: SwitchBotModel.K10,
        bleModel: SwitchBotBLEModel.Unknown,
        bleModelName: SwitchBotBLEModelName.Unknown,
        bleModelFriendlyName: SwitchBotBLEModelFriendlyName.Unknown,
      },
      'K10+ Pro': {
        model: SwitchBotModel.K10Pro,
        bleModel: SwitchBotBLEModel.Unknown,
        bleModelName: SwitchBotBLEModelName.Unknown,
        bleModelFriendlyName: SwitchBotBLEModelFriendlyName.Unknown,
      },
      'WoSweeper': {
        model: SwitchBotModel.WoSweeper,
        bleModel: SwitchBotBLEModel.Unknown,
        bleModelName: SwitchBotBLEModelName.Unknown,
        bleModelFriendlyName: SwitchBotBLEModelFriendlyName.Unknown,
      },
      'WoSweeperMini': {
        model: SwitchBotModel.WoSweeperMini,
        bleModel: SwitchBotBLEModel.Unknown,
        bleModelName: SwitchBotBLEModelName.Unknown,
        bleModelFriendlyName: SwitchBotBLEModelFriendlyName.Unknown,
      },
      'Robot Vacuum Cleaner S1': {
        model: SwitchBotModel.RobotVacuumCleanerS1,
        bleModel: SwitchBotBLEModel.Unknown,
        bleModelName: SwitchBotBLEModelName.Unknown,
        bleModelFriendlyName: SwitchBotBLEModelFriendlyName.Unknown,
      },
      'Robot Vacuum Cleaner S1 Plus': {
        model: SwitchBotModel.RobotVacuumCleanerS1Plus,
        bleModel: SwitchBotBLEModel.Unknown,
        bleModelName: SwitchBotBLEModelName.Unknown,
        bleModelFriendlyName: SwitchBotBLEModelFriendlyName.Unknown,
      },
      'Robot Vacuum Cleaner S10': {
        model: SwitchBotModel.RobotVacuumCleanerS10,
        bleModel: SwitchBotBLEModel.Unknown,
        bleModelName: SwitchBotBLEModelName.Unknown,
        bleModelFriendlyName: SwitchBotBLEModelFriendlyName.Unknown,
      },
      'Ceiling Light': {
        model: SwitchBotModel.CeilingLight,
        bleModel: SwitchBotBLEModel.CeilingLight,
        bleModelName: SwitchBotBLEModelName.CeilingLight,
        bleModelFriendlyName: SwitchBotBLEModelFriendlyName.CeilingLight,
      },
      'Ceiling Light Pro': {
        model: SwitchBotModel.CeilingLightPro,
        bleModel: SwitchBotBLEModel.CeilingLightPro,
        bleModelName: SwitchBotBLEModelName.CeilingLightPro,
        bleModelFriendlyName: SwitchBotBLEModelFriendlyName.CeilingLightPro,
      },
      'Strip Light': {
        model: SwitchBotModel.StripLight,
        bleModel: SwitchBotBLEModel.StripLight,
        bleModelName: SwitchBotBLEModelName.StripLight,
        bleModelFriendlyName: SwitchBotBLEModelFriendlyName.StripLight,
      },
      'Indoor Cam': {
        model: SwitchBotModel.IndoorCam,
        bleModel: SwitchBotBLEModel.Unknown,
        bleModelName: SwitchBotBLEModelName.Unknown,
        bleModelFriendlyName: SwitchBotBLEModelFriendlyName.Unknown,
      },
      'Remote': {
        model: SwitchBotModel.Remote,
        bleModel: SwitchBotBLEModel.Unknown,
        bleModelName: SwitchBotBLEModelName.Unknown,
        bleModelFriendlyName: SwitchBotBLEModelFriendlyName.Unknown,
      },
      'remote with screen+': {
        model: SwitchBotModel.UniversalRemote,
        bleModel: SwitchBotBLEModel.Unknown,
        bleModelName: SwitchBotBLEModelName.Unknown,
        bleModelFriendlyName: SwitchBotBLEModelFriendlyName.Unknown,
      },
      'Battery Circulator Fan': {
        model: SwitchBotModel.BatteryCirculatorFan,
        bleModel: SwitchBotBLEModel.Unknown,
        bleModelName: SwitchBotBLEModelName.Unknown,
        bleModelFriendlyName: SwitchBotBLEModelFriendlyName.Unknown,
      },
    }
    const defaultDevice = {
      model: SwitchBotModel.Unknown,
      bleModel: SwitchBotBLEModel.Unknown,
      bleModelName: SwitchBotBLEModelName.Unknown,
      bleModelFriendlyName: SwitchBotBLEModelFriendlyName.Unknown,
    }
    const deviceConfig = deviceMapping[device.deviceType] || defaultDevice
    device.model = deviceConfig.model
    device.bleModel = deviceConfig.bleModel
    device.bleModelName = deviceConfig.bleModelName
    device.bleModelFriednlyName = deviceConfig.bleModelFriednlyName
    this.debugLog(`Model: ${device.model}, BLE Model: ${device.bleModel}, BLE Model Name: ${device.bleModelName}, BLE Model Friendly Name: ${device.bleModelFriednlyName}`)

    const deviceFirmwareVersion = device.firmware ?? device.version ?? accessory.context.version ?? this.platform.version ?? '0.0.0'
    const version = deviceFirmwareVersion.toString()
    this.debugLog(`Firmware Version: ${version.replace(/^V|-.*$/g, '')}`)
    let deviceVersion: string
    if (version?.includes('.') === false) {
      const replace = version?.replace(/^V|-.*$/g, '')
      const match = replace?.match(/./g)
      const validVersion = match?.join('.')
      deviceVersion = validVersion ?? '0.0.0'
    } else {
      deviceVersion = version.replace(/^V|-.*$/g, '') ?? '0.0.0'
    }
    accessory
      .getService(this.hap.Service.AccessoryInformation)!
      .setCharacteristic(this.hap.Characteristic.HardwareRevision, deviceVersion)
      .setCharacteristic(this.hap.Characteristic.SoftwareRevision, deviceVersion)
      .setCharacteristic(this.hap.Characteristic.FirmwareRevision, deviceVersion)
      .getCharacteristic(this.hap.Characteristic.FirmwareRevision)
      .updateValue(deviceVersion)
    accessory.context.version = deviceVersion
    this.debugSuccessLog(`version: ${accessory.context.version}`)
  }

  async statusCode(statusCode: number): Promise<void> {
    const statusMessages = {
      151: 'Command not supported by this deviceType',
      152: 'Device not found',
      160: 'Command is not supported',
      161: 'Device is offline',
      171: `Hub Device is offline. Hub: ${this.device.hubDeviceId}`,
      190: 'Device internal error due to device states not synchronized with server, or command format is invalid',
      100: 'Command successfully sent',
      200: 'Request successful',
      400: 'Bad Request, an invalid payload request',
      401: 'Unauthorized, Authorization for the API is required, but the request has not been authenticated',
      403: 'Forbidden, The request has been authenticated but does not have appropriate permissions, or a requested resource is not found',
      404: 'Not Found, Specifies the requested path does not exist',
      406: 'Not Acceptable, a MIME type has been requested via the Accept header for a value not supported by the server',
      415: 'Unsupported Media Type, a contentType header has been defined that is not supported by the server',
      422: 'Unprocessable Entity: The server cannot process the request, often due to exceeded API limits.',
      429: 'Too Many Requests, exceeded the number of requests allowed for a given time window',
      500: 'Internal Server Error, An unexpected error occurred. These errors should be rare',
    }
    if (statusCode === 171 && (this.device.hubDeviceId === this.device.deviceId || this.device.hubDeviceId === '000000000000')) {
      this.debugErrorLog(`statusCode 171 changed to 161: hubDeviceId ${this.device.hubDeviceId} matches deviceId ${this.device.deviceId}, device is its own hub.`)
      statusCode = 161
    }
    const logMessage = statusMessages[statusCode] || `Unknown statusCode: ${statusCode}, Submit Bugs Here: https://tinyurl.com/SwitchBotBug`
    const logMethod = [100, 200].includes(statusCode) ? 'debugLog' : statusMessages[statusCode] ? 'errorLog' : 'infoLog'
    this[logMethod](`${logMessage}, statusCode: ${statusCode}`)
  }

  /**
   * Logging for Device
   */
  infoLog(...log: any[]): void {
    if (this.enablingDeviceLogging()) {
      this.log.info(`${this.device.deviceType}: ${this.accessory.displayName}`, String(...log))
    }
  }

  successLog(...log: any[]): void {
    if (this.enablingDeviceLogging()) {
      this.log.success(`${this.device.deviceType}: ${this.accessory.displayName}`, String(...log))
    }
  }

  debugSuccessLog(...log: any[]): void {
    if (this.enablingDeviceLogging()) {
      if (this.loggingIsDebug()) {
        this.log.success(`[DEBUG] ${this.device.deviceType}: ${this.accessory.displayName}`, String(...log))
      }
    }
  }

  warnLog(...log: any[]): void {
    if (this.enablingDeviceLogging()) {
      this.log.warn(`${this.device.deviceType}: ${this.accessory.displayName}`, String(...log))
    }
  }

  debugWarnLog(...log: any[]): void {
    if (this.enablingDeviceLogging()) {
      if (this.loggingIsDebug()) {
        this.log.warn(`[DEBUG] ${this.device.deviceType}: ${this.accessory.displayName}`, String(...log))
      }
    }
  }

  errorLog(...log: any[]): void {
    if (this.enablingDeviceLogging()) {
      this.log.error(`${this.device.deviceType}: ${this.accessory.displayName}`, String(...log))
    }
  }

  debugErrorLog(...log: any[]): void {
    if (this.enablingDeviceLogging()) {
      if (this.loggingIsDebug()) {
        this.log.error(`[DEBUG] ${this.device.deviceType}: ${this.accessory.displayName}`, String(...log))
      }
    }
  }

  debugLog(...log: any[]): void {
    if (this.enablingDeviceLogging()) {
      if (this.deviceLogging === 'debug') {
        this.log.info(`[DEBUG] ${this.device.deviceType}: ${this.accessory.displayName}`, String(...log))
      } else if (this.deviceLogging === 'debugMode') {
        this.log.debug(`${this.device.deviceType}: ${this.accessory.displayName}`, String(...log))
      }
    }
  }

  loggingIsDebug(): boolean {
    return this.deviceLogging === 'debugMode' || this.deviceLogging === 'debug'
  }

  enablingDeviceLogging(): boolean {
    return this.deviceLogging === 'debugMode' || this.deviceLogging === 'debug' || this.deviceLogging === 'standard'
  }
}
