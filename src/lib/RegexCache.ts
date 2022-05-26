import { __internals } from '../normalize';
import { toRegexPattern } from './dict';
import LRU from 'lru-cache';
import { currentConfig } from '../config';
import { kan2num } from './kan2num';
import { findKanjiNumbers } from '@geolonia/japanese-numeral';

interface Prefecture {
	name: string
	cities: string[]
}

interface City {
	name: string
	towns: Town[]
}

interface Town {
	name: string
	koaza: string
	lat: number
	lng: number
}

interface CachedRegex {
	key: string
	regex: RegExp
}

export class RegexCache {
	private cachedPrefectures: Prefecture[] = [];
	private cachedPrefectureRegexes: CachedRegex[] = [];
	private cachedSameNamedPrefectureCityRegexes: CachedRegex[] = [];
	private cachedCityRegexes: Record<string, CachedRegex[]> = {};
	private cachedTowns: Record<string, Record<string, Town[]>> = {};
	private cachedTownRegexes = new LRU<string, (CachedRegex & Town)[]>({
		max: currentConfig.townCacheSize,
		maxAge: 60 * 60 * 24 * 7 * 1000, // 7日間
	})

	public getPref = async (): Promise<Prefecture[]> => {
		if (typeof this.cachedPrefectures !== 'undefined') {
			return this.cachedPrefectures
		}

		const prefectures: Prefecture[] = [];
		const resp = await __internals.fetch('.json') // ja.json
		const data = await resp.json()
		for (const key in data) {
			prefectures.push({
				name: key,
				cities: data[key]
			})
		}
		return prefectures
	}

	public getPrefectureRegexes = (prefList: Prefecture[]): CachedRegex[] => {
		if (this.cachedPrefectureRegexes) {
			return this.cachedPrefectureRegexes
		}

		this.cachedPrefectureRegexes = prefList.map((prefecture) => {
			// `東京` の様に末尾の `都府県` が抜けた住所に対応
			const key = prefecture.name.replace(/(都|道|府|県)$/, '')
			const regex = new RegExp(`${key}(都|道|府|県)?`)
			return {
				key: prefecture.name,
				regex: regex
			}
		})

		return this.cachedPrefectureRegexes;
	}

	public getSameNamedPrefectureCityRegexes = (prefList: Prefecture[]): CachedRegex[] => {
		if (typeof this.cachedSameNamedPrefectureCityRegexes !== "undefined") {
			return this.cachedSameNamedPrefectureCityRegexes;
		}

		prefList.forEach((prefecture) => {
			// 「福島県石川郡石川町」のように、市の名前が別の都道府県名から始まっているケースも考慮する。
			prefecture.cities.forEach((city) => {
				if (city.indexOf(prefecture.name.replace(/(都|道|府|県)$/, '')) === 0) {
					this.cachedSameNamedPrefectureCityRegexes.push({
						key: `${prefecture.name}${city}`,
						regex: new RegExp(`^${city}`)
					})
				}
			})
		})

		return this.cachedSameNamedPrefectureCityRegexes
	}

	public getCityRegexes = (prefecture: Prefecture): CachedRegex[] => {
		const cachedRegexes = this.cachedCityRegexes[prefecture.name];
		if (typeof cachedRegexes !== 'undefined') {
			return cachedRegexes;
		}

		// 少ない文字数の地名に対してミスマッチしないように文字の長さ順にソート
		const cities = prefecture.cities.sort((a: string, b: string) => {
			return b.length - a.length
		})

		const cityRegexes = prefecture.cities.map((city) => {
			let pattern = `^${toRegexPattern(city)}`
			if (city.match(/(町|村)$/)) {
				pattern = `^${toRegexPattern(city).replace(/(.+?)郡/, '($1郡)?')}` // 郡が省略されてるかも
			}
			return {
				key: city,
				regex: new RegExp(pattern)
			}
		})
		this.cachedCityRegexes[prefecture.name]
		return cityRegexes
	}

	public getTowns = async (pref: string, city: string): Promise<Town[]> => {
		const cachedTowns = this.cachedTowns[pref][city]
		if (typeof cachedTowns !== 'undefined') {
			return cachedTowns
		}

		const responseTownsResp = await __internals.fetch(
			['', encodeURI(pref), encodeURI(city) + '.json'].join('/'),
		)
		const towns = (await responseTownsResp.json()) as Town[]
		this.cachedTowns[pref][city] = towns;
		return towns
	}

	public getTownRegexes = async (prefecture: Prefecture, city: City): Promise<(CachedRegex & Town)[]> => {
		const cachedRegexes = this.cachedTownRegexes.get(prefecture.name + city.name)
		if (typeof cachedRegexes !== 'undefined') {
			return cachedRegexes
		}


		const pre_towns = await this.getTowns(prefecture.name, city.name)
		const townSet = new Set(pre_towns.map((town) => town.name))
		const towns = []


		// 十六町 のように漢数字と町が連結しているか
		const isKanjiNumberFollewedByCho = (targetTownName: string) => {
			const xCho = targetTownName.match(/.町/g)
			if (!xCho) return false
			const kanjiNumbers = findKanjiNumbers(xCho[0])
			return kanjiNumbers.length > 0
		}

		// 町丁目に「○○町」が含まれるケースへの対応
		// 通常は「○○町」のうち「町」の省略を許容し同義語として扱うが、まれに自治体内に「○○町」と「○○」が共存しているケースがある。
		// この場合は町の省略は許容せず、入力された住所は書き分けられているものとして正規化を行う。
		// 更に、「愛知県名古屋市瑞穂区十六町1丁目」漢数字を含むケースだと丁目や番地・号の正規化が不可能になる。このようなケースも除外。
		for (const town of pre_towns) {
			towns.push(town)

			const originalTown = town.name
			if (originalTown.indexOf('町') === -1) continue
			const townAbbr = originalTown.replace(/(?!^町)町/g, '') // NOTE: 冒頭の「町」は明らかに省略するべきではないので、除外
			if (
				!townSet.has(townAbbr) &&
				!townSet.has(`大字${townAbbr}`) && // 大字は省略されるため、大字〇〇と〇〇町がコンフリクトする。このケースを除外
				!isKanjiNumberFollewedByCho(originalTown)
			) {
				// エイリアスとして町なしのパターンを登録
				towns.push({
					...town,
					originalTown,
					town: townAbbr,
				})
			}
		}

		// 少ない文字数の地名に対してミスマッチしないように文字の長さ順にソート
		towns.sort((a, b) => {
			let aLen = a.name.length
			let bLen = b.name.length

			// 大字で始まる場合、優先度を低く設定する。
			// 大字XX と XXYY が存在するケースもあるので、 XXYY を先にマッチしたい
			if (a.name.startsWith('大字')) aLen -= 2
			if (b.name.startsWith('大字')) bLen -= 2

			return bLen - aLen
		})

		const patterns = towns.map((town) => {
			const pattern = toRegexPattern(
				town.name
					// 横棒を含む場合（流通センター、など）に対応
					.replace(/[-－﹣−‐⁃‑‒–—﹘―⎯⏤ーｰ─━]/g, '[-－﹣−‐⁃‑‒–—﹘―⎯⏤ーｰ─━]')
					.replace(/大?字/g, '(大?字)?')
					// 以下住所マスターの町丁目に含まれる数字を正規表現に変換する
					.replace(
						/([壱一二三四五六七八九十]+)(丁目?|番(町|丁)|条|軒|線|(の|ノ)町|地割|号)/g,
						(match: string) => {
							const patterns = []

							patterns.push(
								match
									.toString()
									.replace(/(丁目?|番(町|丁)|条|軒|線|(の|ノ)町|地割|号)/, ''),
							) // 漢数字

							if (match.match(/^壱/)) {
								patterns.push('一')
								patterns.push('1')
								patterns.push('１')
							} else {
								const num = match
									.replace(/([一二三四五六七八九十]+)/g, (match) => {
										return kan2num(match)
									})
									.replace(/(丁目?|番(町|丁)|条|軒|線|(の|ノ)町|地割|号)/, '')

								patterns.push(num.toString()) // 半角アラビア数字
							}

							// 以下の正規表現は、上のよく似た正規表現とは違うことに注意！
							const _pattern = `(${patterns.join(
								'|',
							)})((丁|町)目?|番(町|丁)|条|軒|線|の町?|地割|号|[-－﹣−‐⁃‑‒–—﹘―⎯⏤ーｰ─━])`

							return _pattern // デバッグのときにめんどくさいので変数に入れる。
						},
					),
			)

			if (city.name.match(/^京都市/)) {
				return {
					key: town.name,
					regex: new RegExp(`.*${pattern}`),
					...town
				}
			} else {
				return {
					key: town.name,
					regex: new RegExp(`^${pattern}`),
					...town
				}
			}
		})

		this.cachedTownRegexes.set(prefecture.name + city.name, patterns)
		return patterns
	}
}