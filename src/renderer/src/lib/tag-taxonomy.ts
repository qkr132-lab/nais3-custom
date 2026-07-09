/**
 * 태그 탐색기용 하드코딩 분류 체계 (커스텀).
 * 신체 부위 → 관련 의상/악세서리처럼 카테고리로 태그를 훑어보는 용도.
 * 태그명은 실제 단부루 태그 — 존재하지 않는 이름은 tags:lookup에서 자동 제외된다.
 */

export interface TagGroup {
  name: string
  tags: string[]
}

export interface TagCategory {
  name: string
  groups: TagGroup[]
}

export const TAG_TAXONOMY: TagCategory[] = [
  {
    name: '신체',
    groups: [
      {
        name: '가슴',
        tags: [
          'breasts', 'small breasts', 'medium breasts', 'large breasts', 'huge breasts',
          'flat chest', 'cleavage', 'sideboob', 'underboob', 'breasts squeezed together',
          'bouncing breasts', 'hanging breasts', 'breast hold', 'breast rest', 'breast press',
          'between breasts', 'collarbone', 'nipples', 'covered nipples', 'areolae'
        ]
      },
      {
        name: '가슴 관련 의상/악세서리',
        tags: [
          'bra', 'sports bra', 'bandeau', 'tube top', 'pasties', 'sarashi', 'bikini top only',
          'cleavage cutout', 'underbust', 'front-tie top', 'strapless', 'breast pocket',
          'chest harness', 'chest jewel', 'strap gap', 'crop top overhang', 'muneate'
        ]
      },
      {
        name: '허벅지/다리',
        tags: [
          'thighs', 'thick thighs', 'thigh gap', 'zettai ryouiki', 'legs', 'long legs',
          'bare legs', 'kneepits', 'skindentation', 'crossed legs', 'spread legs',
          'legs together', 'legs up', 'leg lift', 'm legs', 'knees together feet apart'
        ]
      },
      {
        name: '허벅지/다리 악세서리',
        tags: [
          'thighhighs', 'thigh strap', 'frilled thigh strap', 'thighlet', 'garter straps',
          'garter belt', 'thigh boots', 'kneehighs', 'leg warmers', 'leg ribbon', 'anklet',
          'pantyhose', 'fishnet thighhighs', 'lace-trimmed thighhighs', 'torn thighhighs',
          'single thighhigh', 'asymmetrical legwear', 'knee pads', 'toeless legwear'
        ]
      },
      {
        name: '엉덩이/허리',
        tags: [
          'ass', 'huge ass', 'butt crack', 'ass focus', 'ass visible through thighs',
          'wide hips', 'narrow waist', 'hip bones', 'hip focus', 'hip vent', 'groin',
          'waist apron', 'waist bow', 'belt', 'sash', 'obi', 'belt pouch'
        ]
      },
      {
        name: '배/배꼽',
        tags: [
          'navel', 'midriff', 'midriff peek', 'stomach', 'belly', 'abs', 'covered navel',
          'navel cutout', 'navel piercing', 'crop top', 'toned'
        ]
      },
      {
        name: '어깨/팔/손',
        tags: [
          'bare shoulders', 'off shoulder', 'single bare shoulder', 'shoulder cutout',
          'shoulder blades', 'armpits', 'armpit crease', 'bare arms', 'arm warmers',
          'elbow gloves', 'wrist cuffs', 'wrist scrunchie', 'bracelet', 'bangle',
          'spiked bracelet', 'bead bracelet', 'wristband', 'wristwatch', 'fingernails',
          'long fingernails', 'nail polish', 'sharp fingernails', 'ring'
        ]
      },
      {
        name: '발',
        tags: [
          'feet', 'barefoot', 'toes', 'soles', 'toenails', 'toenail polish', 'foot focus',
          'tiptoes', 'plantar flexion', 'no shoes', 'anklet'
        ]
      },
      {
        name: '피부',
        tags: [
          'dark skin', 'dark-skinned female', 'pale skin', 'tan', 'tanlines', 'shiny skin',
          'colored skin', 'sweat', 'steaming body', 'wet', 'oil', 'mole', 'mole under eye',
          'mole on breast', 'freckles', 'scar', 'tattoo', 'body markings', 'skindentation'
        ]
      }
    ]
  },
  {
    name: '얼굴',
    groups: [
      {
        name: '눈/눈동자',
        tags: [
          'heterochromia', 'multicolored eyes', 'gradient eyes', 'glowing eyes',
          'sparkling eyes', 'empty eyes', 'blank eyes', 'half-closed eyes', 'closed eyes',
          'one eye closed', 'wide-eyed', 'heart-shaped pupils', 'star-shaped pupils',
          'slit pupils', 'cross-shaped pupils', 'bright pupils', 'white pupils',
          'symbol-shaped pupils', 'ringed eyes', 'colored sclera', 'black sclera',
          'bags under eyes', 'tsurime', 'tareme', 'sanpaku', 'eyeshadow', 'eyeliner',
          'long eyelashes', 'symbol in eye'
        ]
      },
      {
        name: '입/치아',
        tags: [
          'open mouth', 'closed mouth', 'parted lips', 'fang', 'skin fang', 'sharp teeth',
          'round teeth', 'upper teeth only', 'clenched teeth', 'tongue', 'tongue out',
          'licking lips', 'lips', 'puckered lips', 'pout', 'wavy mouth', 'triangle mouth',
          'chestnut mouth', ':3', ':d', ':p', ':o', ':t', 'w', 'dot nose', 'drooling', 'saliva'
        ]
      },
      {
        name: '표정',
        tags: [
          'smile', 'grin', 'smirk', 'smug', 'light smile', 'seductive smile', 'evil smile',
          'blush', 'light blush', 'full-face blush', 'embarrassed', 'flustered', 'shy',
          'expressionless', 'frown', 'light frown', 'angry', 'annoyed', 'sad', 'crying',
          'tears', 'happy tears', 'surprised', 'confused', 'worried', 'nervous',
          'nervous sweating', 'scared', 'sleepy', 'bored', 'determined', 'serious',
          'thinking', 'naughty face', 'ahegao', 'shaded face', 'sweatdrop', 'nosebleed'
        ]
      },
      {
        name: '머리 모양',
        tags: [
          'long hair', 'very long hair', 'short hair', 'medium hair', 'bob cut', 'hime cut',
          'twintails', 'ponytail', 'side ponytail', 'high ponytail', 'braid', 'twin braids',
          'single braid', 'french braid', 'crown braid', 'braided ponytail', 'hair bun',
          'double bun', 'drill hair', 'twin drills', 'ringlets', 'wavy hair', 'curly hair',
          'messy hair', 'ahoge', 'antenna hair', 'sidelocks', 'hair intakes', 'blunt bangs',
          'swept bangs', 'parted bangs', 'crossed bangs', 'curtained hair', 'hair between eyes',
          'hair over one eye', 'two side up', 'one side up', 'half updo', 'hair down',
          'multicolored hair', 'two-tone hair', 'gradient hair', 'streaked hair',
          'colored inner hair', 'short hair with long locks', 'low-tied long hair'
        ]
      },
      {
        name: '머리 장식',
        tags: [
          'hair ornament', 'hairclip', 'hairpin', 'hair flower', 'hair bow', 'hair ribbon',
          'hairband', 'bow hairband', 'frilled hairband', 'lolita hairband', 'headband',
          'hair scrunchie', 'hair bell', 'hair bobbles', 'x hair ornament',
          'star hair ornament', 'heart hair ornament', 'butterfly hair ornament',
          'feather hair ornament', 'crescent hair ornament', 'leaf hair ornament',
          'hair stick', 'bun cover', 'hair tubes', 'headpiece', 'head wreath', 'tiara',
          'crown', 'mini crown', 'circlet', 'veil', 'maid headdress', 'forehead jewel'
        ]
      }
    ]
  },
  {
    name: '의상',
    groups: [
      {
        name: '상의',
        tags: [
          'shirt', 't-shirt', 'collared shirt', 'dress shirt', 'blouse', 'crop top',
          'tank top', 'camisole', 'tube top', 'bandeau', 'hoodie', 'sweater',
          'turtleneck', 'sleeveless turtleneck', 'ribbed sweater', 'virgin killer sweater',
          'cardigan', 'open cardigan', 'vest', 'sweater vest', 'sailor shirt', 'gym shirt',
          'cropped shirt', 'tied shirt', 'undershirt', 'off-shoulder shirt', 'tunic'
        ]
      },
      {
        name: '하의',
        tags: [
          'skirt', 'miniskirt', 'microskirt', 'long skirt', 'pleated skirt', 'pencil skirt',
          'high-waist skirt', 'suspender skirt', 'plaid skirt', 'denim skirt', 'layered skirt',
          'pants', 'jeans', 'shorts', 'short shorts', 'micro shorts', 'denim shorts',
          'dolphin shorts', 'bike shorts', 'leggings', 'buruma', 'bloomers', 'petticoat',
          'hakama skirt', 'hakama short skirt', 'overalls'
        ]
      },
      {
        name: '원피스/드레스',
        tags: [
          'dress', 'long dress', 'short dress', 'sundress', 'evening gown', 'cocktail dress',
          'wedding dress', 'china dress', 'off-shoulder dress', 'strapless dress',
          'backless dress', 'halter dress', 'sleeveless dress', 'pinafore dress',
          'sweater dress', 'sailor dress', 'frilled dress', 'layered dress', 'pleated dress',
          'armored dress', 'collared dress'
        ]
      },
      {
        name: '교복/제복',
        tags: [
          'school uniform', 'serafuku', 'black serafuku', 'sailor collar', 'neckerchief',
          'blazer', 'gakuran', 'gym uniform', 'winter uniform', 'summer uniform',
          'military uniform', 'naval uniform', 'police uniform', 'nurse cap', 'lab coat',
          'business suit', 'black suit', 'office lady', 'maid', 'maid apron', 'enmaided',
          'wa maid', 'nun', 'habit', 'miko', 'nontraditional miko', 'red hakama'
        ]
      },
      {
        name: '전통복',
        tags: [
          'kimono', 'yukata', 'short kimono', 'open kimono', 'print kimono', 'obi', 'haori',
          'hakama', 'japanese clothes', 'hanbok', 'korean clothes', 'china dress',
          'chinese clothes', 'hanfu', 'wa lolita', 'sarashi', 'tabi', 'geta', 'zouri'
        ]
      },
      {
        name: '수영복',
        tags: [
          'swimsuit', 'bikini', 'string bikini', 'micro bikini', 'frilled bikini',
          'side-tie bikini bottom', 'front-tie bikini top', 'o-ring bikini', 'highleg bikini',
          'striped bikini', 'print bikini', 'bikini skirt', 'one-piece swimsuit',
          'school swimsuit', 'competition swimsuit', 'casual one-piece swimsuit',
          'highleg swimsuit', 'highleg one-piece swimsuit', 'swimsuit under clothes',
          'bikini under clothes', 'sarong', 'swim ring', 'innertube', 'beachball'
        ]
      },
      {
        name: '속옷',
        tags: [
          'underwear', 'underwear only', 'panties', 'side-tie panties', 'lowleg panties',
          'highleg panties', 'boyshort panties', 'string panties', 'bow panties', 'thong',
          'bra', 'sports bra', 'strapless bra', 'bow bra', 'lace-trimmed bra',
          'lace-trimmed panties', 'lingerie', 'babydoll', 'negligee', 'chemise', 'corset',
          'bustier', 'garter belt', 'bodystocking', 'no bra', 'no panties',
          'panties under pantyhose', 'male underwear'
        ]
      },
      {
        name: '양말/스타킹',
        tags: [
          'thighhighs', 'black thighhighs', 'white thighhighs', 'striped thighhighs',
          'pantyhose', 'black pantyhose', 'white pantyhose', 'fishnet pantyhose',
          'thighband pantyhose', 'kneehighs', 'socks', 'ankle socks', 'loose socks',
          'frilled socks', 'mismatched legwear', 'uneven legwear', 'pantyhose under shorts'
        ]
      },
      {
        name: '신발',
        tags: [
          'shoes', 'sneakers', 'boots', 'knee boots', 'thigh boots', 'ankle boots',
          'high heels', 'high heel boots', 'platform footwear', 'mary janes', 'loafers',
          'sandals', 'slippers', 'uwabaki', 'geta', 'lace-up boots', 'armored boots',
          'cross-laced footwear'
        ]
      },
      {
        name: '겉옷',
        tags: [
          'jacket', 'leather jacket', 'denim jacket', 'bomber jacket', 'letterman jacket',
          'hooded jacket', 'cropped jacket', 'collared jacket', 'fur-trimmed jacket',
          'open jacket', 'jacket on shoulders', 'coat', 'trench coat', 'winter coat',
          'fur coat', 'duffel coat', 'raincoat', 'fur-trimmed coat', 'coat on shoulders',
          'cape', 'capelet', 'white capelet', 'cloak', 'hooded cloak', 'poncho', 'robe',
          'shawl', 'stole'
        ]
      },
      {
        name: '전신/특수',
        tags: [
          'bodysuit', 'plugsuit', 'leotard', 'highleg leotard', 'strapless leotard',
          'playboy bunny', 'mecha pilot suit', 'armor', 'bikini armor', 'japanese armor',
          'breastplate', 'pauldrons', 'gauntlets', 'greaves', 'latex', 'superhero costume',
          'santa costume', 'animal costume', 'pajamas', 'nightgown', 'apron', 'naked apron',
          'naked shirt', 'naked towel', 'tabard'
        ]
      },
      {
        name: '옷 상태/변형',
        tags: [
          'open clothes', 'open shirt', 'unbuttoned', 'partially unbuttoned', 'unzipped',
          'torn clothes', 'wet clothes', 'wet shirt', 'see-through', 'tight clothes',
          'skin tight', 'taut clothes', 'revealing clothes', 'clothing cutout',
          'clothes lift', 'shirt lift', 'skirt lift', 'dress lift', 'clothes pull',
          'clothing aside', 'strap slip', 'wardrobe malfunction', 'shirt tucked in',
          'clothes around waist', 'oversized clothes', 'impossible clothes',
          'multicolored clothes', 'shiny clothes', 'lifting own clothes'
        ]
      }
    ]
  },
  {
    name: '악세서리',
    groups: [
      {
        name: '귀/목',
        tags: [
          'earrings', 'single earring', 'hoop earrings', 'stud earrings', 'star earrings',
          'heart earrings', 'tassel earrings', 'ear piercing', 'earmuffs',
          'headphones', 'animal ear headphones', 'necklace', 'pendant', 'bead necklace',
          'pearl necklace', 'cross necklace', 'choker', 'black choker', 'ribbon choker',
          'spiked collar', 'belt collar', 'collar', 'neck bell', 'neck ring', 'neck ribbon',
          'necktie', 'bowtie', 'ascot', 'scarf', 'headphones around neck'
        ]
      },
      {
        name: '안경/가면',
        tags: [
          'glasses', 'semi-rimless eyewear', 'rimless eyewear', 'under-rim eyewear',
          'red-framed eyewear', 'black-framed eyewear', 'round eyewear', 'sunglasses',
          'tinted eyewear', 'eyewear on head', 'monocle', 'bespectacled', 'eyepatch',
          'medical eyepatch', 'blindfold', 'mask', 'mouth mask', 'surgical mask',
          'fox mask', 'mask on head', 'goggles', 'goggles on head', 'visor cap'
        ]
      },
      {
        name: '모자',
        tags: [
          'hat', 'witch hat', 'beret', 'beanie', 'baseball cap', 'sun hat', 'straw hat',
          'top hat', 'mini top hat', 'mini hat', 'fedora', 'peaked cap', 'garrison cap',
          'cabbie hat', 'newsboy cap', 'flat cap', 'bucket hat', 'nightcap', 'party hat',
          'santa hat', 'sailor hat', 'military hat', 'mob cap', 'animal hat', 'nurse cap',
          'tokin hat', 'hat ribbon', 'hat bow', 'hat ornament', 'hat flower', 'hat feather',
          'tilted headwear', 'ears through headwear'
        ]
      },
      {
        name: '동물 귀/꼬리/날개',
        tags: [
          'animal ears', 'cat ears', 'dog ears', 'fox ears', 'wolf ears', 'rabbit ears',
          'mouse ears', 'bear ears', 'horse ears', 'cow ears', 'tiger ears', 'raccoon ears',
          'fake animal ears', 'animal ear hairband', 'animal ear fluff', 'extra ears',
          'tail', 'cat tail', 'fox tail', 'dog tail', 'wolf tail', 'horse tail',
          'rabbit tail', 'demon tail', 'dragon tail', 'multiple tails', 'two tails',
          'fake tail', 'tail ornament', 'wings', 'angel wings', 'demon wings', 'bat wings',
          'butterfly wings', 'fairy wings', 'feathered wings', 'ice wings', 'head wings',
          'low wings', 'mini wings', 'horns', 'single horn', 'demon horns', 'dragon horns',
          'curved horns', 'curled horns', 'fake horns', 'oni horns', 'halo',
          'mechanical halo', 'antlers', 'antennae', 'head fins'
        ]
      },
      {
        name: '들고 있는 것',
        tags: [
          'holding', 'holding weapon', 'holding sword', 'holding gun', 'holding knife',
          'holding staff', 'holding polearm', 'holding umbrella', 'holding phone',
          'holding book', 'holding flower', 'holding bouquet', 'holding bag', 'holding cup',
          'holding food', 'holding fruit', 'holding candy', 'holding tray', 'holding plate',
          'holding fork', 'holding spoon', 'holding chopsticks', 'holding bottle',
          'holding can', 'holding fan', 'holding stuffed toy', 'holding gift',
          'holding instrument', 'holding microphone', 'holding poke ball',
          'holding cigarette', 'holding animal', 'holding cat', 'holding hair', 'mouth hold'
        ]
      }
    ]
  },
  {
    name: '구도/시선',
    groups: [
      {
        name: '프레이밍',
        tags: [
          'portrait', 'upper body', 'lower body', 'full body', 'cowboy shot', 'close-up',
          'wide shot', 'face', 'eye focus', 'ass focus', 'foot focus', 'hip focus',
          'solo focus', 'male focus', 'out of frame', 'cropped legs', 'cropped torso',
          'head out of frame', 'feet out of frame', 'letterboxed', 'profile', 'multiple views',
          'reference sheet', 'cross-section', 'x-ray', 'zoom layer', 'chibi inset'
        ]
      },
      {
        name: '앵글',
        tags: [
          'from above', 'from below', 'from behind', 'from side', 'straight-on',
          'dutch angle', 'pov', 'pov hands', 'pov crotch', 'fisheye', 'vanishing point',
          'foreshortening', 'upside-down', 'rotated', 'sideways'
        ]
      },
      {
        name: '시선',
        tags: [
          'looking at viewer', 'looking away', 'looking back', 'looking to the side',
          'looking down', 'looking up', 'looking at another', 'looking afar',
          'looking ahead', 'looking over eyewear', 'eye contact', 'sideways glance',
          'facing viewer', 'facing away', 'facing another', 'blank stare'
        ]
      },
      {
        name: '심도/흐림',
        tags: [
          'depth of field', 'blurry', 'blurry background', 'blurry foreground', 'bokeh',
          'motion blur', 'motion lines', 'afterimage', 'emphasis lines', 'chromatic aberration',
          'film grain', 'lens flare', 'vignetting', 'backlighting'
        ]
      }
    ]
  },
  {
    name: '포즈/동작',
    groups: [
      {
        name: '기본 자세',
        tags: [
          'standing', 'sitting', 'kneeling', 'squatting', 'lying', 'on back', 'on stomach',
          'on side', 'all fours', 'top-down bottom-up', 'fetal position', 'wariza', 'seiza',
          'indian style', 'yokozuwari', 'crossed legs', 'knees up', 'knees to chest',
          'hugging own legs', 'standing on one leg', 'on one knee', 'leaning forward',
          'leaning back', 'bent over', 'arched back', 'twisted torso', 'contrapposto',
          'straddling', 'sitting on lap', 'sitting on person', 'invisible chair'
        ]
      },
      {
        name: '손/팔 동작',
        tags: [
          'arms up', 'arm up', 'arms behind back', 'arms behind head', 'arms at sides',
          'crossed arms', 'outstretched arms', 'outstretched arm', 'outstretched hand',
          'reaching', 'reaching towards viewer', 'spread arms', 'v arms', 'v', 'double v',
          'peace symbol', 'thumbs up', 'ok sign', 'clenched hand', 'raised fist', 'open hand',
          'paw pose', 'claw pose', 'heart hands', 'own hands together', 'own hands clasped',
          'interlocked fingers', 'praying', 'clapping', 'waving', 'salute', 'pointing',
          'pointing at viewer', 'pointing at self', 'shushing', 'finger to mouth',
          'hand on own hip', 'hands on own hips', 'hand on own chest', 'hands on own chest',
          'hand on own cheek', 'hand on own chin', 'hand on own face', 'hands on own face',
          'hand on own head', 'hand on own thigh', 'hand on own knee', 'hand between legs',
          'arm under breasts', 'hand in own hair', 'adjusting hair', 'hand in pocket',
          'hands in pockets', 'arm support', 'arm at side'
        ]
      },
      {
        name: '움직임',
        tags: [
          'walking', 'running', 'jumping', 'floating', 'flying', 'falling', 'crawling',
          'climbing', 'swimming', 'dancing', 'stretching', 'kicking', 'punching', 'riding',
          'wading', 'split', 'leg up', 'leg lift', 'head tilt', 'looking back', 'fighting stance',
          'dynamic pose', 'posing', 'contortion'
        ]
      },
      {
        name: '상호작용',
        tags: [
          'hug', 'hug from behind', 'holding hands', 'headpat', 'kiss', 'kissing cheek',
          'kissing forehead', 'imminent kiss', 'french kiss', 'eye contact', 'face-to-face',
          'back-to-back', 'princess carry', 'carrying', 'piggyback', 'shoulder carry',
          'lap pillow', 'cuddling', 'sleeping together', 'sharing food', 'feeding',
          "hand on another's head", "hand on another's shoulder", "hand on another's face",
          "grabbing another's arm", "holding another's wrist", 'height difference',
          'petting', 'tickling', 'massage', 'ear cleaning', 'shared scarf'
        ]
      }
    ]
  },
  {
    name: '배경/장소',
    groups: [
      {
        name: '자연',
        tags: [
          'outdoors', 'nature', 'forest', 'bamboo forest', 'tree', 'cherry tree', 'palm tree',
          'grass', 'meadow', 'field', 'wheat field', 'flower field', 'garden', 'mountain',
          'hill', 'cliff', 'cave', 'desert', 'island', 'ocean', 'beach', 'shore', 'lake',
          'pond', 'river', 'waterfall', 'underwater', 'partially submerged',
          'onsen', 'sky', 'cloud', 'horizon', 'sunset', 'sunrise', 'night sky', 'starry sky',
          'full moon', 'crescent moon', 'aurora', 'rainbow', 'snow', 'rain', 'fog'
        ]
      },
      {
        name: '도시/실내',
        tags: [
          'indoors', 'city', 'cityscape', 'city lights', 'street', 'road', 'alley',
          'crosswalk', 'lamppost', 'power lines', 'rooftop', 'train station', 'train interior',
          'bus stop', 'school', 'classroom', 'hallway', 'library', 'gym', 'infirmary',
          'cafe', 'restaurant', 'izakaya', 'convenience store', 'shop', 'bakery', 'arcade',
          'movie theater', 'hospital', 'church', 'shrine', 'torii', 'temple', 'castle',
          'palace', 'throne room', 'dungeon', 'ruins', 'graveyard', 'bedroom', 'bed',
          'on bed', 'canopy bed', 'living room', 'couch', 'on couch', 'kitchen', 'bathroom',
          'bathtub', 'balcony', 'window', 'windowsill', 'curtains', 'stairs', 'tatami',
          'kotatsu', 'fireplace', 'wooden floor', 'tile floor', 'east asian architecture'
        ]
      },
      {
        name: '시간/계절/이벤트',
        tags: [
          'day', 'night', 'evening', 'morning', 'dusk', 'dawn', 'twilight',
          'spring (season)', 'summer', 'autumn', 'winter', 'cherry blossoms',
          'autumn leaves', 'snowing', 'festival', 'summer festival', 'fireworks',
          'christmas', 'christmas tree', 'halloween', "jack-o'-lantern", 'valentine',
          'new year', 'birthday', 'party', 'wedding', 'confetti'
        ]
      },
      {
        name: '단색/추상 배경',
        tags: [
          'simple background', 'white background', 'black background', 'grey background',
          'gradient background', 'two-tone background', 'transparent background',
          'abstract background', 'patterned background', 'polka dot background',
          'striped background', 'checkered background', 'floral background',
          'starry background', 'heart background', 'sparkle background', 'dark background',
          'outside border', 'border', 'rounded corners'
        ]
      }
    ]
  },
  {
    name: '효과/스타일',
    groups: [
      {
        name: '빛/입자',
        tags: [
          'sparkle', 'glowing', 'light particles', 'sunlight', 'sunbeam',
          'dappled sunlight', 'light rays', 'moonlight', 'backlighting', 'lens flare',
          'glint', 'neon lights', 'bubble', 'soap bubbles', 'petals', 'falling petals',
          'falling leaves', 'feathers', 'falling feathers', 'snowflakes', 'embers',
          'fire', 'blue fire', 'electricity', 'magic', 'magic circle', 'energy',
          'aura', 'steam', 'smoke', 'explosion', 'debris', 'glass shards'
        ]
      },
      {
        name: '색감/화풍',
        tags: [
          'monochrome', 'greyscale', 'sepia', 'partially colored', 'spot color',
          'limited palette', 'pastel colors', 'muted color', 'high contrast', 'colorful',
          'neon palette', 'anime coloring', 'flat color', 'cel shading', 'watercolor (medium)',
          'oil painting (medium)', 'sketch', 'lineart', 'no lineart', 'thick lineart',
          'traditional media', 'marker (medium)', 'colored pencil (medium)', 'painterly',
          'realistic', 'photorealistic', 'retro artstyle', '1980s (style)', '1990s (style)',
          'pixel art', 'chibi', 'oekaki', 'style parody', 'animification'
        ]
      },
      {
        name: '만화 기호',
        tags: [
          'speech bubble', 'thought bubble', 'spoken heart', 'spoken question mark',
          'spoken ellipsis', 'spoken exclamation mark', 'heart', 'musical note',
          'eighth note', 'zzz', 'anger vein', 'flying sweatdrops', 'notice lines',
          'squiggle', 'puff of air', '?', '!', '!?', '!!', '...', '+++', '^^^'
        ]
      },
      {
        name: '테마/장르',
        tags: [
          'fantasy', 'science fiction', 'cyberpunk', 'steampunk', 'horror (theme)',
          'gothic', 'lolita fashion', 'gothic lolita', 'meme', 'parody', 'crossover',
          'personification', 'mecha musume', 'magical girl', 'virtual youtuber',
          'monster girl', 'furry', 'kemonomimi mode', 'genderswap', 'dual persona',
          'multiple persona', 'time paradox', 'aged down', 'aged up', 'alternate costume',
          'official alternate costume', 'adapted costume', 'alternate hairstyle',
          'alternate hair color', 'alternate eye color', 'alternate breast size', 'cosplay'
        ]
      }
    ]
  }
]
