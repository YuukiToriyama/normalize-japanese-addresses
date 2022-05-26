import { getPrefectures } from './cacheRegexes'
import { RegexCache } from './RegexCache';

const regexCache = new RegexCache();


/**
 * 都道府県の特定
 * @param addr 住所
 */
export const detectPrefName = async (addr: string): Promise<{ pref: string, addr: string } | undefined> => {
	const result = {
		pref: "", // 都道府県名
		addr: "" // それ以降の住所
	}
	const prefectures = await regexCache.getPref();
	const prefRegexes = regexCache.getPrefectureRegexes(prefectures);
	const sameNamedPrefectureCityRegexes = regexCache.getSameNamedPrefectureCityRegexes(prefectures);

	// 県名が省略されており、かつ市の名前がどこかの都道府県名と同じ場合(例.千葉県千葉市)、
	// あらかじめ県名を補完しておく。
	for (let i = 0; i < sameNamedPrefectureCityRegexes.length; i++) {
		const cachedRegex = sameNamedPrefectureCityRegexes[i]
		const match = addr.match(cachedRegex.regex)
		if (match) {
			addr = addr.replace(cachedRegex.regex, cachedRegex.key)
			break
		}
	}

	for (let i = 0; i < prefRegexes.length; i++) {
		const cachedRegex = prefRegexes[i]
		const match = addr.match(cachedRegex.regex);
		if (match) {
			result.pref = cachedRegex.key
			addr = addr.substring(match[0].length) // 都道府県名以降の住所
			break
		}
	}

	// 都道府県名が省略されている場合
	if (!result.pref) {
		const matched: { pref: string, city: string, addr: string }[] = []
		prefectures.forEach(async (pref) => {
			const detected = await detectCityName(addr, pref.name)
			if (typeof detected !== 'undefined') {
				matched.push({
					pref: pref.name,
					...detected
				})
			}
		})
		// マッチする都道府県が複数ある場合は町名まで正規化して都道府県名を判別する。（例: 東京都府中市と広島県府中市など）
		if (1 === matched.length) {
			result.pref = matched[0].pref
		} else {
			for (let i = 0; i < matched.length; i++) {
				const townName = await detectTownName(
					matched[i].addr,
					matched[i].pref,
					matched[i].city
				)
				if (typeof townName !== 'undefined') {
					result.pref = matched[i].pref
				}
			}
		}
	}
	result.addr = addr;
	return result.pref === "" ? undefined : result
}

export const detectCityName = async (addr: string, pref: string): Promise<{ city: string, addr: string } | undefined> => {
	const result = {
		city: "", // 市区町村
		addr: "" // それ以降の住所
	}
	const regexCache = new RegexCache();
	const prefecture = (await regexCache.getPref()).filter(x => x.name === pref)[0]
	const cityRegexes = regexCache.getCityRegexes(prefecture)

	addr.trim()
	for (let i = 0; i < cityRegexes.length; i++) {
		const cachedRegex = cityRegexes[i]
		const match = addr.match(cachedRegex.regex)
		if (match) {
			result.city = cachedRegex.key
			result.addr = addr.substring(match[0].length)
			break
		}
	}
	return result.city === "" ? undefined : result
}

export const detectTownName = async (addr: string, pref: string, city: string) => {
	addr = addr.trim().replace(/^大字/, '')
	const townPatterns = await getTownRegexPatterns(pref, city)

	for (let i = 0; i < townPatterns.length; i++) {
		const [_town, pattern] = townPatterns[i]
		const match = addr.match(pattern)
		if (match) {
			return {
				town: _town.originalTown || _town.town,
				addr: addr.substring(match[0].length),
				lat: _town.lat,
				lng: _town.lng,
			}
		}
	}
}